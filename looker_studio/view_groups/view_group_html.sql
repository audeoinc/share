-- =====================================================================
-- suffix 違い View のロジック グループ比較の UDF を作る
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    再生成: node looker_studio/view_groups/build_udf.mjs
--    本体は esbuild で最小化してある（インラインのコード ブロブは
--    32 KB までに制限されるため。素の連結は約 48 KB で確実に弾かれる）。
--
-- 作る関数は 7 つ。名前はすべて CONFIGURATION の値から組み立てる。
--   viewlgc_analyze             View 群を解析して JSON を返す（JavaScript）
--   viewlgc_render              その JSON を比較 HTML にする（JavaScript）
--   viewlgc_erd                 参照関係の図を作る（JavaScript）
--   viewlgc_page                カラム定義と SQL を作り、外側タブで束ねる（JavaScript）
--   viewlgc_markdown            base ごとのメモ（Markdown）を HTML にする（JavaScript）
--   viewlgc_group_css           テンプレートに貼る CSS を返す（JavaScript）
--   viewlgc_render_dynamic_sql  build_table.sql の __…__ を展開する（SQL）
--
-- 解析と描画を分けてあるのは、インラインのコード ブロブが 1 個あたり 32 KB
-- までのため。JS UDF の中から別の UDF は呼べないので、つなぐのは呼び出し側
-- の SQL（build_table.sql が analyze を 1 回呼び、その結果を render に渡す）。
--
-- 命名と設定の書き方は lineage プロジェクト（lineage/sql/setup/
-- 01_setup_lineage_environment.sql）にそろえてある。
--   UDF 名: udf_name_prefix + system_name + '_' + 基本名 + udf_name_suffix
-- =====================================================================


SET @@location = 'asia-northeast1';

BEGIN
-- ---------------------------------------------------------------------
-- CONFIGURATION（書き換えるのはここだけ）
--
--   [A] 環境ごとに必ず見るもの
--   [B] 既定のままで動くもの
--   [C] 導出・内部用。編集しない
--
--   リージョンは先頭の SET @@location が唯一の置き場所。
--   SET @@location は DECLARE より前に置く。このスクリプトは
--   EXECUTE IMMEDIATE で DDL を投げるだけで、ロケーションを推測できる
--   テーブル参照が無いため、指定しないと既定のロケーションで実行される。
-- ---------------------------------------------------------------------
-- [A] 環境ごとに必ず見るもの ------------------------------------------
-- プロジェクト ID は実行時に自動検出する（[C]）。別プロジェクトに作る
-- ときだけ [C] の udf_project_id にリテラルを入れて固定する。
--
-- プロジェクト トークンの置換
DECLARE project_token_pattern STRING DEFAULT r'^([^-]+)';
-- このシステムを表す名前。すべてのオブジェクト名の先頭に入る
DECLARE system_name STRING DEFAULT 'viewlgc';
-- UDF の置き場所
DECLARE udf_dataset STRING DEFAULT 'ops_meta';
-- UDF の命名（prefix / suffix）
DECLARE udf_name_prefix STRING DEFAULT '';
DECLARE udf_name_suffix STRING DEFAULT '';
--
-- 変数の説明:
--   project_token_pattern
--     自動検出したプロジェクト ID からこの正規表現で切り出したトークン
--     （REGEXP_EXTRACT。キャプチャがあればグループ 1）が、下の名前に書いた
--     '{project_token}' をすべて置き換える。例: プロジェクト
--     'mycompany-prod-123' に r'-([^-]+)-' なら 'prod' になるので、
--     udf_name_suffix='_{project_token}' が '_prod' になる。
--     一致しなければ '' になり、残った '{project_token}' は下の ASSERT で落ちる。
--   system_name
--     このシステムを表す名前。関数もテーブルもビューも、この名前と '_' が
--     先頭に入る（既定なら viewlgc_analyze / viewlgc_t_diff）。
--     同じプロジェクトに別のシステムを同居させたときに、どのオブジェクトが
--     どのシステムのものかを名前だけで見分けるためのもの。
--     **build_table.sql の同名の変数と必ず同じ値にすること。**
--     違う値だと関数が見つからない。英数字と '_' だけ（'-' は不可）。
--   udf_dataset
--     3 つの関数を作るデータセット。build_table.sql の同名の変数と合わせること。
--   udf_name_prefix / udf_name_suffix
--     関数名は udf_name_prefix + system_name + '_' + 基本名 + udf_name_suffix で
--     組み立てる。system_name は環境ではなくシステムを表すので、prefix とは別。
--     ルーチン名は英数字と '_' しか使えない（'-' は不可）ので、テーブル側の
--     prefix / suffix とは別に持つ。build_table.sql の同名の変数と合わせること。

-- [B] 既定のままで動くもの --------------------------------------------
-- 関数名（[C] で組み立てる）。基本名はリテラルで、変えるならここではなく
-- 下の SET を直す。build_table.sql の同名の変数と必ず同じ値にすること。
DECLARE udf_analyze_function_name  STRING;
DECLARE udf_render_function_name   STRING;
DECLARE udf_erd_function_name      STRING;
DECLARE udf_page_function_name     STRING;
DECLARE udf_markdown_function_name STRING;
DECLARE udf_css_function_name      STRING;
DECLARE udf_sql_function_name      STRING;

-- [C] 導出・内部用。編集しない ----------------------------------------
-- プロジェクトは自動検出した値を使う。別プロジェクトに作るときだけ
-- DEFAULT にリテラルを入れて固定する（COALESCE で非 NULL が勝つ）。
DECLARE default_project_id STRING;
DECLARE udf_project_id     STRING DEFAULT NULL;
DECLARE project_token      STRING;

-- 関数の本体（JavaScript）。ここは触らない。
-- SQL 文に直接埋めず変数に置くのは、本体を r""" """ で囲む必要があり、
-- それをさらに EXECUTE IMMEDIATE の文字列に入れ子にできないため。
-- 埋め込むときは TO_JSON_STRING で SQL の文字列リテラルに変換する
-- （JSON のエスケープは BigQuery の文字列リテラルと互換）。
DECLARE js_analyze STRING DEFAULT r"""
var E=Object.defineProperty,k=Object.defineProperties;var A=Object.getOwnPropertyDescriptors;var g=Object.getOwnPropertySymbols;var T=Object.prototype.hasOwnProperty,C=Object.prototype.propertyIsEnumerable;var x=(e,t,n)=>t in e?E(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,m=(e,t)=>{for(var n in t||(t={}))T.call(t,n)&&x(e,n,t[n]);if(g)for(var n of g(t))C.call(t,n)&&x(e,n,t[n]);return e},S=(e,t)=>k(e,A(t));const DQ="\\u0022",DQ3=DQ+DQ+DQ,TOKEN_RE=new RegExp(["(`[^`]*`)","([rbRB]{1,2}(?:'''[\\s\\S]*?'''|"+DQ3+"[\\s\\S]*?"+DQ3+"|'[^']*'|"+DQ+"[^"+DQ+"]*"+DQ+"))","('''[\\s\\S]*?''')","("+DQ3+"[\\s\\S]*?"+DQ3+")","('(?:\\\\.|''|[^'\\\\])*')","("+DQ+"(?:\\\\.|"+DQ+DQ+"|[^"+DQ+"\\\\])*"+DQ+")","(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(0[xX][0-9a-fA-F]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],n=String(e==null?"":e);let o;for(TOKEN_RE.lastIndex=0;(o=TOKEN_RE.exec(n))!==null;){let i;o[1]?i="quoted":o[2]||o[3]||o[4]||o[5]||o[6]?i="string":o[7]||o[8]?i="comment":o[9]?i="number":o[10]?i=KEYWORDS.has(o[10].toUpperCase())?"keyword":"ident":o[11]?i="space":i="punct",t.push({kind:i,text:o[0]})}return t}function stripOptionsClause(e){const t=[];let n=0;for(;n<e.length;){const o=e[n];if(o.kind==="keyword"&&o.text.toUpperCase()==="OPTIONS"){let i=n+1;for(;i<e.length&&e[i].kind==="space";)i++;if(i<e.length&&e[i].text==="("){let u=0,s=i;for(;s<e.length;s++)if(e[s].text==="(")u++;else if(e[s].text===")"&&(u--,u===0)){s++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();n=s;continue}}t.push(o),n++}return t}function markEntities(e){const t=e.slice(),n=u=>{let s=u+1;for(;s<t.length&&t[s].kind==="space";)s++;return s},o=[];let i=null;for(let u=0;u<t.length;u++){const s=t[u];if(s.kind==="space"||s.kind==="comment")continue;if(s.text==="("){o.push(i),i=null;continue}if(s.text===")"){o.pop(),i=null;continue}const r=s.text.toUpperCase();if(i=s.kind==="keyword"||s.kind==="ident"?r:null,s.kind!=="keyword"||r!=="FROM"&&r!=="JOIN"||o.length>0&&o[o.length-1]==="EXTRACT")continue;let f=n(u);for(;!(f>=t.length);){const l=t[f];if(l.kind==="quoted")t[f]={kind:"entity",text:l.text},f=n(f);else if(l.kind==="ident"){const a=[];let c=f;for(;;){a.push(c);const p=n(c);if(p<t.length&&t[p].text==="."){const d=n(p);if(d<t.length&&t[d].kind==="ident"){c=d;continue}}break}const h=n(c);if(h<t.length&&t[h].text==="(")break;for(const p of a)t[p]={kind:"entity",text:t[p].text};f=h}else break;if(f<t.length&&t[f].kind==="keyword"&&t[f].text.toUpperCase()==="AS"){const a=n(f);a<t.length&&(t[a].kind==="ident"||t[a].kind==="quoted")&&(f=n(a))}else f<t.length&&t[f].kind==="ident"&&(f=n(f));if(f<t.length&&t[f].text===","){f=n(f);continue}break}}return t}function normalizeSpace(e){return e.map(t=>t.kind==="space"?{kind:"space",text:" "}:t)}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/;function expandSuffixParts(e){let t=[""];for(const n of e){const o=[];for(const i of t)for(const u of n)o.push(i+u);t=o}return t.sort((n,o)=>o.length-n.length||n.localeCompare(o))}function extractSuffix(e,t){const n=t||{};if(Array.isArray(n.suffixParts)&&n.suffixParts.length>0){const u=n._expanded||(n._expanded=expandSuffixParts(n.suffixParts));for(const s of u)if(e.length>s.length+1&&e.endsWith("_"+s)){const r=[];let f=s;for(const l of n.suffixParts){const a=l.find(c=>f.startsWith(c));if(a===void 0){r.length=0;break}r.push(a),f=f.slice(a.length)}return{base:e.slice(0,-(s.length+1)),suffix:s,parts:r.length?r:void 0}}return null}if(Array.isArray(n.suffixList)&&n.suffixList.length>0){let u=null;for(const s of n.suffixList)e.length>s.length+1&&e.endsWith("_"+s)&&(u===null||s.length>u.length)&&(u=s);return u===null?null:{base:e.slice(0,-(u.length+1)),suffix:u}}const o=n.suffixPattern?new RegExp(n.suffixPattern):DEFAULT_SUFFIX_RE,i=String(e).match(o);return i?{base:i[1],suffix:i[2]}:null}const DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001";function suffixWords(e,t){const n=String(e||"");if(n.length<2)return[];const o=[n];if(Array.isArray(t)&&t.length>0)for(const s of t)String(s).length>=2&&o.push(String(s));else if(n.indexOf("_")>0)for(const s of n.split("_"))s.length>=2&&o.push(s);else n.length%2===0&&o.push(n.slice(0,n.length/2),n.slice(n.length/2));const i={},u=[];for(const s of o){const r=s.toLowerCase();i[r]||(i[r]=1,u.push(r))}return u}function buildLiteralMap(e){if(!Array.isArray(e)||e.length===0)return null;const t=typeof e[0]=="string"?[e]:e,n={};let o=0;for(let i=0;i<t.length;i++){if(!Array.isArray(t[i]))continue;const u=LITERAL_MARK+(i+1)+LITERAL_MARK;for(const s of t[i]){const r=String(s==null?"":s).toLowerCase();r&&(n[r]=u,o++)}}return o>0?n:null}function parseEquivalents(e){const t=e||{},n=t.equivalentLiterals;if(Array.isArray(n)){let o=!1;const i=[],u=[];for(const s of n)Array.isArray(s)?i.push(s):String(s).toLowerCase()==="suffix"?o=!0:s!=null&&u.push(s);return i.length===0&&u.length>0&&i.push(u),{useWords:o,groups:i.length>0?i:null}}return{useWords:t.literalSuffixWords!==!1,groups:Array.isArray(t.literalGroups)?t.literalGroups:null}}function maskTokens(e,t,n,o){const i=String(t||""),u=i.length>=2,s=parseEquivalents(o),r=u&&s.useWords?suffixWords(i,n):[],f=buildLiteralMap(s.groups);return!u&&r.length===0&&!f?e:e.map(l=>{if(l.kind==="space")return l;let a=l.text;if(u&&a.indexOf(i)>=0&&(a=a.split(i).join(SUFFIX_MARK)),r.length>0||f){const c=l.kind==="string"&&a.length>=2?a.slice(1,-1):l.kind==="number"?a:null;if(c){const h=c.toLowerCase(),p=r.indexOf(h)>=0?SUFFIX_MARK:f&&f[h];p&&(a=l.kind==="string"?a[0]+p+a[0]:p)}}return a===l.text?l:{kind:l.kind,text:a}})}function alphaMapDetail(e,t,n){if(e.length!==t.length)return{ok:!1,reason:"length",aLen:e.length,bLen:t.length};const o=new Set(n&&n.substitutable||DEFAULT_SUBSTITUTABLE),i=new Map,u=new Map;for(let s=0;s<e.length;s++){const r=e[s],f=t[s],l=a=>({ok:!1,reason:a,index:s,kind:r.kind,otherKind:f.kind,aText:r.text,bText:f.text});if(r.kind!==f.kind)return l("kind");if(r.text!==f.text){if(!o.has(r.kind))return l("not-substitutable");if(i.has(r.text)&&i.get(r.text)!==f.text)return l("inconsistent");if(u.has(f.text)&&u.get(f.text)!==r.text)return l("not-injective");i.set(r.text,f.text),u.set(f.text,r.text)}}return{ok:!0,fwd:i,rev:u}}function parameterize(e){const t=e[0].tokens.length,n=new Map,o=[],i=[];for(let u=0;u<t;u++){if(e[0].tokens[u].kind==="space"){i.push(e[0].raw[u].text);continue}const s=e.map(l=>l.raw[u].text);let r=!0;for(let l=1;l<s.length;l++)if(s[l]!==s[0]){r=!1;break}if(r){i.push(s[0]);continue}const f=JSON.stringify(s);if(!n.has(f)){const l="P"+(o.length+1);n.set(f,l);const a={};e.forEach((c,h)=>{a[c.suffix]=s[h]}),o.push({name:l,kind:e[0].raw[u].kind,values:a})}i.push("{{"+n.get(f)+"}}")}return{sql:i.join(""),params:o}}function groupByLogic(e,t){const n=!(t&&t.stripOptions===!1),o=!(t&&t.suffixAware===!1),i=e.map(r=>{let f=tokenizeSql(r.ddl);n&&(f=stripOptionsClause(f)),f=markEntities(f);const l=normalizeSpace(f);return S(m({},r),{raw:f,tokens:maskTokens(l,o?r.suffix:null,r.parts,t)})}),u=[];for(const r of i){let f=null;for(const l of u)if(alphaMapDetail(l.members[0].tokens,r.tokens,t).ok){f=l;break}f?f.members.push(r):u.push({members:[r]})}u.sort((r,f)=>f.members.length-r.members.length||String(r.members[0].suffix).localeCompare(String(f.members[0].suffix)));const s=u.map(r=>r.members[0]);return u.map((r,f)=>{const l=r.members.slice().sort((h,p)=>String(h.suffix).localeCompare(String(p.suffix))),a=parameterize(l),c=s.map((h,p)=>p===f?null:{vs:h.suffix,detail:alphaMapDetail(h.tokens,r.members[0].tokens,t)});return{suffixes:l.map(h=>h.suffix),members:l,sql:a.sql,params:a.params,missBy:c,miss:c[0]}})}function analyze(e,t){const n=!(t&&t.includeUnmatched===!1),o=new Map,i=[];for(const s of e){const r=extractSuffix(s.view_name,t);if(!r){i.push(s);continue}o.has(r.base)||o.set(r.base,[]),o.get(r.base).push({viewName:s.view_name,suffix:r.suffix,parts:r.parts,ddl:s.ddl})}const u=[];for(const[s,r]of o){const f=groupByLogic(r,t);u.push({base:s,viewCount:r.length,groupCount:f.length,groups:f})}if(n)for(const s of i){const r=[{viewName:s.view_name,suffix:null,parts:null,ddl:s.ddl}];u.push({base:s.view_name,viewCount:1,groupCount:1,groups:groupByLogic(r,t),unmatched:!0})}return u.sort((s,r)=>r.groupCount-s.groupCount||s.base.localeCompare(r.base)),{bases:u,unmatched:i}}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __trimBase(e){for(var t=[],n=0;n<e.groups.length;n++){for(var o=e.groups[n],i=[],u=0;u<o.members.length;u++)i.push({viewName:o.members[u].viewName});t.push({suffixes:o.suffixes,members:i,sql:o.sql,params:o.params,miss:o.miss,missBy:o.missBy})}return{base:e.base,viewCount:e.viewCount,groupCount:e.groupCount,unmatched:e.unmatched,groups:t}}function __label(e){for(var t=[],n=0;n<e.suffixes.length;n++)t.push(e.suffixes[n]||e.members[n]&&e.members[n].viewName||"(suffix \u306A\u3057)");return t.join(", ")}function __payload(e){return{viewCount:0,groupCount:0,groupLabels:[],groupSizes:[],suffixes:[],unmatchedCount:0,bases:[],lead:e||"",tail:""}}function __run(e,t){var n=__opts(t);if(!e||e.length===0)return JSON.stringify(__payload("View \u304C\u6E21\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"));for(var o=[],i=0;i<e.length;i++)e[i]&&o.push({view_name:e[i].view_name,ddl:e[i].ddl});var u=analyze(o,n);if(u.bases.length===0){var s=__payload(o.length+" \u4EF6\u3059\u3079\u3066 suffix \u3092\u8A8D\u8B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002suffixParts / suffixList / suffixPattern \u306E\u6307\u5B9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return s.unmatchedCount=u.unmatched.length,JSON.stringify(s)}for(var r=__payload(""),f=0;f<u.bases.length;f++){var l=u.bases[f];r.bases.push(__trimBase(l)),r.viewCount+=l.viewCount,r.groupCount+=l.groupCount;for(var a=0;a<l.groups.length;a++){var c=l.groups[a];r.groupLabels.push(__label(c)),r.groupSizes.push(c.members.length);for(var h=0;h<c.suffixes.length;h++)r.suffixes.push(c.suffixes[h]||c.members[h].viewName)}}return r.suffixes.sort(),r.unmatchedCount=u.unmatched.length,u.unmatched.length>0&&n.includeUnmatched===!1&&(r.tail="suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u304C "+u.unmatched.length+" \u4EF6\u3042\u308A\u307E\u3059\u3002"),JSON.stringify(r)}return __run(views,options_json);

""";

DECLARE js_render STRING DEFAULT r"""
var h=Object.defineProperty;var f=Object.getOwnPropertySymbols;var x=Object.prototype.hasOwnProperty,v=Object.prototype.propertyIsEnumerable;var b=(e,n,t)=>n in e?h(e,n,{enumerable:!0,configurable:!0,writable:!0,value:t}):e[n]=t,u=(e,n)=>{for(var t in n||(n={}))x.call(n,t)&&b(e,t,n[t]);if(f)for(var t of f(n))v.call(n,t)&&b(e,t,n[t]);return e};const MAX_TABS=12,MAX_REF_TABS=12,MAX_SQL_TABS=24,MAX_DESC_TABS=16,REF_BUDGET=41943040,OUTER_TABS=["note","\u30AB\u30E9\u30E0\u5B9A\u7FA9","\u53C2\u7167\u95A2\u4FC2","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","SQL"],MAX_OUTER_TABS=8,NOTE_MARK="<!--VG_NOTE-->",CSS_GEN=3;function hashId(e){let n=2166136261;for(let t=0;t<String(e).length;t++)n^=String(e).charCodeAt(t),n=Math.imul(n,16777619)>>>0;return n.toString(36)}const label=e=>e.suffixes.map((n,t)=>n||e.members[t]&&e.members[t].viewName||"(suffix \u306A\u3057)").join(", ");function badge(e,n,t){return`<span class="vg-badge" style="color:${n};background:${t}">${esc(e)}</span>`}function header(e,n,t,r){const o=t>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${n} View`,"#57606A","#EAEEF2")+badge(`${t} \u30B0\u30EB\u30FC\u30D7`,o?"#9A6700":"#1A7F37",o?"#FFF8C5":"#DAFBE1")+(r?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e;function diffLines(e,n){const t=e.length,r=n.length,o=[];for(let s=0;s<=t;s++)o.push(new Int32Array(r+1));for(let s=t-1;s>=0;s--)for(let p=r-1;p>=0;p--)o[s][p]=e[s]===n[p]?o[s+1][p+1]+1:Math.max(o[s+1][p],o[s][p+1]);const i=[];let a=0,c=0;for(;a<t&&c<r;)e[a]===n[c]?(i.push({type:"equal",aIndex:a,bIndex:c,text:e[a]}),a++,c++):o[a+1][c]>=o[a][c+1]?(i.push({type:"del",aIndex:a,text:e[a]}),a++):(i.push({type:"add",bIndex:c,text:n[c]}),c++);for(;a<t;)i.push({type:"del",aIndex:a,text:e[a]}),a++;for(;c<r;)i.push({type:"add",bIndex:c,text:n[c]}),c++;return i}function lcsMatchFlags(e,n){const t=e.length,r=n.length,o=[];for(let s=0;s<=t;s++)o.push(new Int32Array(r+1));for(let s=t-1;s>=0;s--)for(let p=r-1;p>=0;p--)o[s][p]=e[s]===n[p]?o[s+1][p+1]+1:Math.max(o[s+1][p],o[s][p+1]);const i=new Array(t).fill(!1);let a=0,c=0;for(;a<t&&c<r;)e[a]===n[c]?(i[a]=!0,a++,c++):o[a+1][c]>=o[a][c+1]?a++:c++;return i}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const n=[];for(const t of e){const r=n[n.length-1];r&&r.hi===t.hi?r.text+=t.text:n.push({text:t.text,hi:t.hi})}return n}function segDiff(e,n){const t=e.length,r=n.length,o=[];for(let p=0;p<=t;p++)o.push(new Int32Array(r+1));for(let p=t-1;p>=0;p--)for(let d=r-1;d>=0;d--)o[p][d]=e[p]===n[d]?o[p+1][d+1]+1:Math.max(o[p+1][d],o[p][d+1]);const i=[],a=[];let c=0,s=0;for(;c<t&&s<r;)e[c]===n[s]?(i.push({text:e[c],hi:!1}),a.push({text:n[s],hi:!1}),c++,s++):o[c+1][s]>=o[c][s+1]?(i.push({text:e[c],hi:!0}),c++):(a.push({text:n[s],hi:!0}),s++);for(;c<t;)i.push({text:e[c],hi:!0}),c++;for(;s<r;)a.push({text:n[s],hi:!0}),s++;return{oldSegs:mergeSegs(i),newSegs:mergeSegs(a)}}function wordDiff(e,n){return segDiff(tokenize(e),tokenize(n))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(s=>[{text:String(s),hi:!1}]);if(e.length===2){const s=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[s.oldSegs,s.newSegs]}const n=tokenizeName(e[0]),t=tokenizeName(e[1]),r=tokenizeName(e[2]),o=segDiff(n,t).newSegs,i=segDiff(n,r).newSegs,a=new Array(n.length).fill(!0);for(const s of[t,r]){const p=lcsMatchFlags(n,s);for(let d=0;d<n.length;d++)a[d]=a[d]&&p[d]}return[mergeSegs(n.map((s,p)=>({text:s,hi:!a[p]}))),o,i]}function build2Way(e,n){const t=diffLines(e,n),r=[];let o=0;for(;o<t.length;){if(t[o].type==="equal"){const s=t[o];r.push({type:"equal",left:{num:s.aIndex+1,segs:[{text:s.text,hi:!1}],kind:"plain"},right:{num:s.bIndex+1,segs:[{text:s.text,hi:!1}],kind:"plain"}}),o++;continue}const i=[];for(;o<t.length&&t[o].type==="del";)i.push(t[o++]);const a=[];for(;o<t.length&&t[o].type==="add";)a.push(t[o++]);const c=Math.max(i.length,a.length);for(let s=0;s<c;s++){const p=i[s],d=a[s];if(p&&d){const l=wordDiff(p.text,d.text);r.push({type:"mod",left:{num:p.aIndex+1,segs:l.oldSegs,kind:"del"},right:{num:d.bIndex+1,segs:l.newSegs,kind:"add"}})}else p?r.push({type:"del",left:{num:p.aIndex+1,segs:[{text:p.text,hi:!1}],kind:"del"},right:null}):r.push({type:"add",left:null,right:{num:d.bIndex+1,segs:[{text:d.text,hi:!1}],kind:"add"}})}}return r}function splitLines(e){const n=String(e).split(/\r\n|\r|\n/);return n.length>1&&n[n.length-1]===""&&n.pop(),n}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=u({},DEFAULTS.T),PANES,S=u({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(t=>t+t).join(""));const n=parseInt(e,16);return[n>>16&255,n>>8&255,n&255]}function toHex(e,n,t){const r=o=>("0"+Math.round(Math.max(0,Math.min(255,o))).toString(16)).slice(-2);return"#"+r(e)+r(n)+r(t)}function mixWhite(e,n){const[t,r,o]=hexToRgb(e),i=a=>255+(a-255)*n;return toHex(i(t),i(r),i(o))}function darken(e,n){const[t,r,o]=hexToRgb(e),i=a=>a*(1-n);return toHex(i(t),i(r),i(o))}function buildPane(e,n,t){return{bg:mixWhite(e,n),hi:mixWhite(e,t),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=u({},DEFAULTS.T),S=u({},DEFAULTS.S);const n=u({},DEFAULTS.paneColors);let t=DEFAULTS.lineOpacity,r=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const o=e.colors||{};HEX.test(o.baseColor||"")&&(n.base=o.baseColor),HEX.test(o.afterColor||"")&&(n.after=o.afterColor),HEX.test(o.refColor||"")&&(n.ref=o.refColor),isNum(e.diffLineOpacity)&&(t=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(r=e.diffCharOpacity);const i=e.syntax||{};i.keyword&&(S.keyword=i.keyword),i.literal&&(S.literal=i.literal),i.comment&&(S.comment=i.comment)}PANES={base:buildPane(n.base,t,r),after:buildPane(n.after,t,r),ref:buildPane(n.ref,t,r)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function esc(e){return String(e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function escAttr(e){return esc(e).replace(/"/g,"&quot;")}const PARAM_HTML_RE=/\{(?:<[^>]+>)*\{(?:<[^>]+>)*(P\d+)(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g;function withTips(e,n,t){if(!n)return e;const r=t?"vg-ph vg-phr":"vg-ph";return e.replace(PARAM_HTML_RE,(o,i)=>{const a=n[i];return a?`<span class="${r}" data-tip="${escAttr(a)}">${o}</span>`:o})}function sqlHighlight(e){const n=e.length;let t=0,r="";const o=(d,l,g)=>`<span style="color:${d};${g?"font-style:italic;":""}">${esc(l)}</span>`,i=d=>d===" "||d==="	",a=d=>d>="0"&&d<="9",c=d=>/[A-Za-z_]/.test(d),s=d=>/[A-Za-z0-9_]/.test(d),p=d=>"=<>!+-*/%|,.();:".indexOf(d)>=0;for(;t<n;){const d=e[t];if(i(d)){let l=t+1;for(;l<n&&i(e[l]);)l++;r+=esc(e.slice(t,l)),t=l;continue}if(d==="-"&&e[t+1]==="-"){r+=o(S.comment,e.slice(t),!0);break}if(d==="'"){let l=t+1;for(;l<n;){if(e[l]==="'"){if(e[l+1]==="'"){l+=2;continue}l++;break}l++}r+=o(S.literal,e.slice(t,l)),t=l;continue}if(a(d)){let l=t+1;for(;l<n&&(a(e[l])||e[l]===".");)l++;r+=o(S.literal,e.slice(t,l)),t=l;continue}if(c(d)){let l=t+1;for(;l<n&&s(e[l]);)l++;const g=e.slice(t,l);SQL_KEYWORDS.has(g.toUpperCase())?r+=o(S.keyword,g):r+=esc(g),t=l;continue}r+=esc(d),t++}return r}function renderSegs(e,n,t,r){if(!e||!e.length)return"&nbsp;";let o="";for(const i of e){const a=sqlHighlight(i.text);o+=i.hi?`<span style="background:${n};border-radius:2px;">${a}</span>`:a}return o===""?"&nbsp;":withTips(o,t,r)}function numTd(e,n,t){const r=t?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${n.numBg};border-right:1px solid ${T.numBorder};${r}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,n){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,n,t){let r=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(r+=`background:${t.bg};border-left:2px solid ${t.bar};`),`<td style="${r}">${n||"&nbsp;"}</td>`}function hatchTd(e,n){const t=n?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${t}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${t}${T.hatch}">&nbsp;</td>`}function labelHtml(e,n){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(t=>t.hi?`<span style="background:${n.hi};border-radius:2px;">${esc(t.text)}</span>`:esc(t.text)).join("")}function th(e,n,t,r,o){const i=o?`border-left:1px solid ${T.border};`:"",a=t?`&nbsp;<span style="color:${r.headText};font-weight:400;">(${esc(t)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${r.headBg};border-bottom:2px solid ${r.bar};${i}padding:7px 12px;">${labelHtml(n,r)}${a}</th>`}function wrapTable(e,n,t,r){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:${r?"visible":"hidden"};font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${n}</tr></thead>
    <tbody>
${t}    </tbody>
  </table>
</div>
`}function renderFragment1(e,n,t,r,o){configure(r);const i='<colgroup><col style="width:40px"><col></colgroup>',a=th(2,e,n,PANES.base,!1);let c="";for(let s=0;s<t.length;s++)c+=`      <tr>${numTd(s+1,PANES.base,!1)}${codeTd("same",withTips(sqlHighlight(t[s]),o),PANES.base)}</tr>
`;return wrapTable(i,a,c,!!o)}function renderFragment2(e,n,t,r,o){configure(r);const i='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',a=nameDiff([e,n]),c=th(3,a[0],"before",PANES.base,!1)+th(3,a[1],"after",PANES.after,!0);let s="";for(const p of t){const d=p.left,l=p.right;let g="";d?g+=numTd(d.num,PANES.base,!1)+markTd(d.kind==="del"?"del":"blank",PANES.base)+codeTd(d.kind,renderSegs(d.segs,PANES.base.hi,o&&o.left),PANES.base):g+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),l?g+=numTd(l.num,PANES.after,!0)+markTd(l.kind==="add"?"add":"blank",PANES.after)+codeTd(l.kind,renderSegs(l.segs,PANES.after.hi,o&&o.right,!0),PANES.after):g+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),s+=`      <tr>${g}</tr>
`}return wrapTable(i,c,s,!!o)}function relabelPanes(e,n){let t=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(r,o,i)=>{const a=n[t++];return a==null?r:o+esc(a)+i})}const paneSub=e=>`${e.members.length} View`,REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u3067\u304D\u306A\u3044\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u5217\u540D\u30FB\u5225\u540D\u30FBCTE \u540D\u30FB\u4E88\u7D04\u8A9E\u306A\u3069\u3002\u7F6E\u63DB\u3057\u3066\u3088\u3044\u306E\u306F FROM / JOIN \u306E\u5B9F\u4F53\u540D\u3068\u5024\u3060\u3051\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e,n,t){const r=s=>String(s==null?"":s).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),o=s=>s.missBy?s.missBy[n]:s.miss,i=e.filter(s=>o(s)).map(s=>{const p=o(s).detail,d=p.reason==="length"?`${p.aLen} \u5BFE ${p.bLen}`:`<code class="vg-mcode">${esc(r(p.aText))}</code> \u2194 <code class="vg-mcode">${esc(r(p.bText))}</code><span class="vg-mkind">${esc(kindText(p.kind))}</span>`;return`<tr><th class="vg-mname">${esc(label(s))}</th><td class="vg-mvs">vs ${esc(t)}</td><td class="vg-mreason">${esc(REASON_TEXT[p.reason]||p.reason)}<br>${d}</td></tr>`}).join("");return i?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(s=>o(s)&&o(s).detail.reason==="not-substitutable"&&(o(s).detail.kind==="string"||o(s).detail.kind==="number"))?'<div class="vg-mhint">\u5024\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u3067\u306F\u5024\u306F\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u3066\u540C\u3058\u30B0\u30EB\u30FC\u30D7\u306B\u3059\u308B\u306E\u3067\u3001<code class="vg-mcode">substitutable</code> \u3092\u7D5E\u3063\u305F\u8A2D\u5B9A\u306B\u306A\u3063\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u306B\u623B\u3059\u306A\u3089 options_json \u304B\u3089 <code class="vg-mcode">"substitutable"</code> \u3092\u5916\u3057\u307E\u3059\u3002<br>\u7D5E\u3063\u305F\u307E\u307E\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>':""}<div class="vg-pblock"><table class="vg-ptable">${i}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(t=>{if(!t.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const r=t.params.map(o=>{const i=Object.entries(o.values).map(([c,s])=>`<div class="vg-pv"><span class="vg-psuf">${esc(c)}</span>${esc(s)}</div>`).join(""),a=`<span class="vg-mkind">${esc(kindText(o.kind))}</span>`;return`<tr><th class="vg-pname">${esc(o.name)}</th><td class="vg-pvals">${a}${i}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><table class="vg-ptable">${r}</table></div>`}).join("")}</details>`}function paramTips(e){const n={};for(const t of e.params)n[t.name]=`${t.name}: ${kindText(t.kind)}
`+Object.entries(t.values).map(([r,o])=>`${r||"(suffix \u306A\u3057)"} = ${o}`).join(`
`);return n}function pair(e,n,t){return relabelPanes(renderFragment2(label(e),label(n),build2Way(splitLines(e.sql),splitLines(n.sql)),t,{left:paramTips(e),right:paramTips(n)}),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(n)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,n,t,r){const o=e[n],i=e.filter((l,g)=>g!==n),a=i.slice(0,12),c=a.map((l,g)=>`<input class="vg-r vg-r${g+1}" type="radio" name="${r}" id="${r}-${g+1}"${g===0?" checked":""}>`).join(""),s=baseTab(o)+a.map((l,g)=>`<label class="vg-tab vg-t${g+1}" for="${r}-${g+1}">${esc(label(l))}<span class="vg-tabn">${l.members.length}</span></label>`).join(""),p=a.length?a.map((l,g)=>`<div class="vg-panel vg-p${g+1}">${pair(o,l,t)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(o),paneSub(o),splitLines(o.sql),t,paramTips(o))}</div>`;return(i.length>a.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D 12 \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${i.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${c}<div class="vg-tablist">${s}</div><div class="vg-panels">${p}</div></div>`}function refPanel(e,n,t){const r=e.groups,o="vgt"+hashId(e.base+"|"+r.map(label).join("|")+"|"+n);return tabs(r,n,t,o)+missTable(r,n,label(r[n]))}function refTabs(e,n,t){const r=e.groups,o=[];let i=0;for(let d=0;d<r.length&&d<12;d++){const l=refPanel(e,d,n);if(o.length&&i+l.length>41943040)break;o.push(l),i+=l.length}const a=o.map((d,l)=>`<input class="vg-br vg-br${l+1}" type="radio" name="${t}b" id="${t}b-${l+1}"${l===0?" checked":""}>`).join(""),c=o.map((d,l)=>`<label class="vg-btab vg-bt${l+1}" for="${t}b-${l+1}">${esc(label(r[l]))}<span class="vg-tabn">${r[l].members.length}</span></label>`).join(""),s=o.map((d,l)=>`<div class="vg-bpanel vg-bp${l+1}">${d}</div>`).join(""),p=o.length<r.length?notice(`\u57FA\u6E96\u306B\u3067\u304D\u308B\u306E\u306F\u5148\u982D ${o.length} \u30B0\u30EB\u30FC\u30D7\u307E\u3067\u306B\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${r.length} \u4EF6\uFF09\u3002\u57FA\u6E96\u3092 1 \u3064\u5897\u3084\u3059\u3068\u6BD4\u8F03\u306E\u679A\u6570\u304C\u30B0\u30EB\u30FC\u30D7\u6570\u3076\u3093\u5897\u3048\u3001\u3053\u306E\u307E\u307E\u3067\u306F 1 \u884C\u304C BigQuery \u306E\u4E0A\u9650\uFF08100 MB\uFF09\u306B\u9054\u3057\u3066\u65E5\u6B21\u306E\u751F\u6210\u3054\u3068\u5931\u6557\u3059\u308B\u305F\u3081\u3001${Math.round(41943040/1024/1024)} MB \u3067\u6B62\u3081\u3066\u3044\u307E\u3059\uFF08\u3053\u3053\u307E\u3067\u3067 ${(i/1024/1024).toFixed(1)} MB\uFF09\u3002\u3053\u306E base \u306F\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3059\u304E\u306A\u3044\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002`):"";return`<div class="vg-btabs">${a}<div class="vg-btablist"><span class="vg-blabel">\u57FA\u6E96\u30B0\u30EB\u30FC\u30D7</span>${c}</div><div class="vg-bpanels">${s}</div></div>`+p}function renderBase(e,n){const t=n||{},r=e.groups,o=r.length,i="vgt"+hashId(e.base+"|"+r.map(label).join("|"));let a;return o===0?a=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):o===1?a=notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`)+refPanel(e,0,t):a=refTabs(e,t,i),'<div class="vg-root">'+header(e.base,e.viewCount,o,e.unmatched)+a+paramsTable(r)+"</div>"}function chromeCss(){const e=[".vg-cssgen3{display:none}",".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font-weight:600;font-size:12px;line-height:1.8;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font-weight:600;font-size:12px;line-height:1.6;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}",".vg-ph{position:relative;margin:0 -2px;padding:0 2px;border-radius:3px;background:#F1E8FD;color:#6639BA;font-weight:700;box-shadow:inset 0 0 0 1px #CDB6F2;cursor:help}",".vg-ph:hover{background:#E4D3FB}",".vg-ph::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}",".vg-ph:hover::after{display:block}",".vg-ph.vg-phr::after{left:auto;right:0}",".vg-br{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-btablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px}",".vg-blabel{color:#57606A;font-size:12px;font-weight:600;margin-right:2px}",".vg-btab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid #D0D7DE;border-radius:14px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px}",".vg-btab:hover{background:#EAEEF2;color:#24292F}",".vg-bpanel{display:none}",".vg-or{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-outer{max-height:min(100vh,2000px);overflow:auto;--vg-bar:75px}",".vg-otablist,.vg-ohead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;position:sticky;top:0;z-index:5;background:#fff;margin:0 0 10px;padding:8px 0;box-shadow:0 1px 0 #EAEEF2}",".vg-otablist>.vg-header,.vg-ohead>.vg-header{flex:0 0 100%;margin:0}",".vg-ohead>.vg-otablist{position:static;padding:0;margin:0;box-shadow:none;flex:0 0 100%}",".vg-opanel .vg-header{display:none}",".vg-otab{display:inline-flex;align-items:center;padding:5px 16px;border:1px solid #D0D7DE;border-radius:16px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px}",".vg-otab:hover{background:#EAEEF2;color:#24292F}",".vg-opanel{display:none}",".vg-erdblock{margin:0 0 28px;border:1px solid #D0D7DE;border-radius:6px;background:#fff}",".vg-erdblock:last-child{margin-bottom:0}",".vg-erdhead{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid #EAEEF2;background:#F6F8FA;border-radius:6px 6px 0 0}",".vg-erdname{font-weight:600;color:#24292F;font-size:12px}",".vg-erdbox{overflow-x:auto;padding:6px 10px 10px}",".vg-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 10px;color:#57606A;font-size:11px}",".vg-lg{display:inline-flex;align-items:center;gap:5px}",".vg-lgm{display:inline-block;width:10px;height:10px;border-radius:2px;border:1px solid #8C96A0}",".vg-lgt{background:#C9A227;border-color:#8C6D3F}",".vg-lgc{background:#4E8FBF;border-color:#3F6D8C}",".vg-lgo{background:#8250DF;border-color:#6D3F8C}",".vg-lgd{display:inline-block;width:18px;border-top:1.5px dashed #8C96A0}"],n=[".vg-otablist > ",".vg-ohead > .vg-otablist > "];for(let t=1;t<=8;t++)e.push(`.vg-or${t}:checked ~ .vg-opanels > .vg-op${t}{display:block}`),e.push(n.map(r=>`.vg-or${t}:checked ~ ${r}.vg-ot${t}`).join(",")+"{background:#24292F;border-color:#24292F;color:#fff}");for(let t=1;t<=12;t++)e.push(`.vg-br${t}:checked ~ .vg-bpanels > .vg-bp${t}{display:block}`),e.push(`.vg-br${t}:checked ~ .vg-btablist > .vg-bt${t}{background:#fbeded;border-color:#efb6b6;color:#24292F}`);for(let t=1;t<=12;t++)e.push(`.vg-r${t}:checked ~ .vg-panels > .vg-p${t}{display:block}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t}{background:#fff;border-color:#D0D7DE;color:#24292F}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t} .vg-tabn{background:#DDF4FF;color:#0969DA}`);return e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(n){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var n=2166136261,t=0;t<e.length;t++)n^=e.charCodeAt(t),n=Math.imul(n,16777619)>>>0;return"d"+n.toString(36)}function __split(e){var n={},t=e.replace(/ style="([^"]*)"/g,function(r,o){var i=__hashClass(o);return n[i]=o,' class="'+i+'"'});return{markup:t,rules:n}}function __rulesToCss(e){for(var n=Object.keys(e).sort(),t=[],r=0;r<n.length;r++)t.push("."+n[r]+"{"+e[n[r]]+"}");return t.join(`
`)}function __applyMode(e,n){if(n==="class")return __split(e).markup;if(n==="embed"){var t=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(t.rules)+`
</style>
`+t.markup}return e}function __run(e,n){var t=__opts(n),r;try{r=JSON.parse(e)}catch(c){r=null}if(!r)return __notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002");for(var o=r.lead?__notice(r.lead):"",i=r.bases||[],a=0;a<i.length;a++)o+=renderBase(i[a],t);return r.tail&&(o+=__notice(r.tail)),__applyMode(o,t.mode||"inline")}return __run(analysis_json,options_json);

""";

DECLARE js_erd STRING DEFAULT r"""
var C=Object.defineProperty,$=Object.defineProperties;var L=Object.getOwnPropertyDescriptors;var v=Object.getOwnPropertySymbols;var _=Object.prototype.hasOwnProperty,U=Object.prototype.propertyIsEnumerable;var M=(t,e,o)=>e in t?C(t,e,{enumerable:!0,configurable:!0,writable:!0,value:o}):t[e]=o,y=(t,e)=>{for(var o in e||(e={}))_.call(e,o)&&M(t,o,e[o]);if(v)for(var o of v(e))U.call(e,o)&&M(t,o,e[o]);return t},w=(t,e)=>$(t,L(e));const MAX_TABS=12,MAX_REF_TABS=12,MAX_SQL_TABS=24,MAX_DESC_TABS=16,REF_BUDGET=41943040,OUTER_TABS=["note","\u30AB\u30E9\u30E0\u5B9A\u7FA9","\u53C2\u7167\u95A2\u4FC2","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","SQL"],MAX_OUTER_TABS=8,NOTE_MARK="<!--VG_NOTE-->",CSS_GEN=3;function esc(t){return String(t==null?"":t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(t){let e=2166136261;for(let o=0;o<String(t).length;o++)e^=String(t).charCodeAt(o),e=Math.imul(e,16777619)>>>0;return e.toString(36)}const label=t=>t.suffixes.map((e,o)=>e||t.members[o]&&t.members[o].viewName||"(suffix \u306A\u3057)").join(", ");function badge(t,e,o){return`<span class="vg-badge" style="color:${e};background:${o}">${esc(t)}</span>`}function header(t,e,o,n){const i=o>1;return`<div class="vg-header"><span class="vg-title">${esc(t)}</span>`+badge(`${e} View`,"#57606A","#EAEEF2")+badge(`${o} \u30B0\u30EB\u30FC\u30D7`,i?"#9A6700":"#1A7F37",i?"#FFF8C5":"#DAFBE1")+(n?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(t){return`<div class="vg-notice">${esc(t)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=t=>KIND_TEXT[t]||t,DQ="\\u0022",DQ3=DQ+DQ+DQ,TOKEN_RE=new RegExp(["(`[^`]*`)","([rbRB]{1,2}(?:'''[\\s\\S]*?'''|"+DQ3+"[\\s\\S]*?"+DQ3+"|'[^']*'|"+DQ+"[^"+DQ+"]*"+DQ+"))","('''[\\s\\S]*?''')","("+DQ3+"[\\s\\S]*?"+DQ3+")","('(?:\\\\.|''|[^'\\\\])*')","("+DQ+"(?:\\\\.|"+DQ+DQ+"|[^"+DQ+"\\\\])*"+DQ+")","(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(0[xX][0-9a-fA-F]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(t){const e=[],o=String(t==null?"":t);let n;for(TOKEN_RE.lastIndex=0;(n=TOKEN_RE.exec(o))!==null;){let i;n[1]?i="quoted":n[2]||n[3]||n[4]||n[5]||n[6]?i="string":n[7]||n[8]?i="comment":n[9]?i="number":n[10]?i=KEYWORDS.has(n[10].toUpperCase())?"keyword":"ident":n[11]?i="space":i="punct",e.push({kind:i,text:n[0]})}return e}function markEntities(t){const e=t.slice(),o=s=>{let c=s+1;for(;c<e.length&&e[c].kind==="space";)c++;return c},n=[];let i=null;for(let s=0;s<e.length;s++){const c=e[s];if(c.kind==="space"||c.kind==="comment")continue;if(c.text==="("){n.push(i),i=null;continue}if(c.text===")"){n.pop(),i=null;continue}const a=c.text.toUpperCase();if(i=c.kind==="keyword"||c.kind==="ident"?a:null,c.kind!=="keyword"||a!=="FROM"&&a!=="JOIN"||n.length>0&&n[n.length-1]==="EXTRACT")continue;let l=o(s);for(;!(l>=e.length);){const f=e[l];if(f.kind==="quoted")e[l]={kind:"entity",text:f.text},l=o(l);else if(f.kind==="ident"){const u=[];let h=l;for(;;){u.push(h);const F=o(h);if(F<e.length&&e[F].text==="."){const d=o(F);if(d<e.length&&e[d].kind==="ident"){h=d;continue}}break}const E=o(h);if(E<e.length&&e[E].text==="(")break;for(const F of u)e[F]={kind:"entity",text:e[F].text};l=E}else break;if(l<e.length&&e[l].kind==="keyword"&&e[l].text.toUpperCase()==="AS"){const u=o(l);u<e.length&&(e[u].kind==="ident"||e[u].kind==="quoted")&&(l=o(u))}else l<e.length&&e[l].kind==="ident"&&(l=o(l));if(l<e.length&&e[l].text===","){l=o(l);continue}break}}return e}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/,DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001",BOX_W_MIN=130,BOX_W_MAX=380,NAME_CHAR_W=6.65,BOX_H=40,GAP_MIN=78,CHAR_W=6.5,LINE_H=14,GAP_Y=14,PAD=10,kw=t=>t&&t.kind==="keyword"?t.text.toUpperCase():null;function prepare(t){const e=[];let o=0;for(const n of markEntities(tokenizeSql(t)))n.kind==="space"||n.kind==="comment"||(n.text===")"&&o--,e.push({kind:n.kind,text:n.text,depth:o}),n.text==="("&&o++);return e}function cteRanges(t){const e=[];if(!(t[0]&&kw(t[0])==="WITH"))return{ctes:e,mainFrom:0};let o=1;for(;;){const n=t[o],i=t[o+1],s=t[o+2];if(!s||n.kind!=="ident"||kw(i)!=="AS"||s.text!=="(")break;const c=s.depth;let a=o+3;for(;a<t.length&&!(t[a].text===")"&&t[a].depth===c);)a++;if(e.push({name:n.text,from:o+3,to:a,depth:c+1}),o=a+1,t[o]&&t[o].text===","){o++;continue}break}return{ctes:e,mainFrom:o}}const STOP=new Set(["WHERE","GROUP","ORDER","QUALIFY","WINDOW","HAVING","UNION","INTERSECT","EXCEPT","LIMIT","SELECT","JOIN","FROM"]);function skipParen(t,e,o){const n=t[e].depth;let i=e+1;for(;i<o&&!(t[i].text===")"&&t[i].depth===n);)i++;return i+1}function readSource(t,e,o){if(e>=o)return{node:null,next:e};const n=t[e];if(n.text==="(")return{node:{name:"(\u30B5\u30D6\u30AF\u30A8\u30EA)",kind:"subquery"},next:skipParen(t,e,o)};if(kw(n)==="UNNEST"){let i=e+1,s="";if(t[i]&&t[i].text==="("){const c=t[i].depth;let a=i+1;for(;a<o&&!(t[a].text===")"&&t[a].depth===c);)s+=t[a].text,a++;i=a+1}return{node:{name:"UNNEST("+s+")",kind:"unnest"},next:i}}if(n.kind==="entity"||n.kind==="quoted"||n.kind==="ident"){const i=[];let s=e;for(;s<o&&(t[s].kind==="entity"||t[s].kind==="quoted"||t[s].kind==="ident");){if(i.push(t[s].text),s++,s<o&&t[s].text==="."){s++;continue}break}return s<o&&t[s].text==="("?{node:null,next:skipParen(t,s,o)}:{node:{name:i.join("."),kind:"ref"},next:s}}return{node:null,next:e+1}}function skipAlias(t,e,o){if(e<o&&kw(t[e])==="AS"){const n=t[e+1];return n&&(n.kind==="ident"||n.kind==="quoted")?e+2:e+1}return e<o&&t[e].kind==="ident"&&!STOP.has(t[e].text.toUpperCase())?e+1:e}function readOnKeys(t,e,o){const n=[];let i=e;for(;i<o;){const s=kw(t[i]);if(s&&STOP.has(s)||s==="LEFT"||s==="RIGHT"||s==="FULL"||s==="INNER"||s==="CROSS")break;if(t[i].text==="="){const c=(f,u,h)=>f&&u&&h&&u.text==="."?h.text:null,a=c(t[i-3],t[i-2],t[i-1]),l=c(t[i+1],t[i+2],t[i+3]);a&&l&&n.push(a===l?a:a+" = "+l)}i++}return{keys:n,next:i}}function readUsingKeys(t,e,o){const n=[];let i=e;if(t[i]&&t[i].text==="("){const s=t[i].depth;for(i++;i<o&&!(t[i].text===")"&&t[i].depth===s);)t[i].kind==="ident"&&n.push(t[i].text),i++;i++}return{keys:n,next:i}}function joinKind(t,e,o){for(let n=e-1;n>=o&&e-n<=3;n--){const i=kw(t[n]);if(i==="LEFT"||i==="RIGHT"||i==="FULL"||i==="CROSS")return i;if(i==="INNER")return"INNER"}return"INNER"}function scanScope(t,e,o,n){const i=[];for(let s=e;s<o;s++){const c=kw(t[s]);if(c!=="FROM"&&c!=="JOIN")continue;const a=t[s].depth>n,l=c==="JOIN"?joinKind(t,s,e):null;let f=s+1;for(;;){const u=readSource(t,f,o);if(f=u.next,u.node){f=skipAlias(t,f,o);let h=[];if(!a&&f<o&&kw(t[f])==="ON"){const E=readOnKeys(t,f+1,o);h=E.keys,f=E.next}else if(!a&&f<o&&kw(t[f])==="USING"){const E=readUsingKeys(t,f+1,o);h=E.keys,f=E.next}u.node.kind!=="unnest"&&i.push({name:u.node.name,kind:u.node.kind,joinType:l,keys:h,nested:a})}if(f<o&&t[f].text===","&&t[f].depth===t[s].depth){f++;continue}break}s=Math.max(s,f-1)}return i}function buildGraph(t,e){const o=new Map((e||[]).map(d=>[d.name,d])),n=d=>{const g=Object.keys(d.values);return g.length?d.values[g[0]]:null},i=new Map,s=String(t).replace(/\{\{(P\d+)\}\}/g,(d,g)=>{const x=o.get(g);if(!x)return d;const k=n(x);return k==null?d:(i.set(k,x),k)}),c=prepare(s),{ctes:a,mainFrom:l}=cteRanges(c),f=new Set(a.map(d=>d.name)),u=new Map,h=[],E=(d,g)=>{const x=g+":"+d;if(!u.has(x)){const k=[],T=i.get(String(d));if(T)k.push(T);else for(const A of String(d).split(".")){const r=i.get(A);r&&k.indexOf(r)<0&&k.push(r)}u.set(x,{id:x,name:d,label:d,kind:g,params:k})}return x},F=a.map(d=>({id:E(d.name,"cte"),from:d.from,to:d.to,depth:d.depth}));F.push({id:E("(\u6700\u7D42 SELECT)","output"),from:l,to:c.length,depth:0});for(const d of F)for(const g of scanScope(c,d.from,d.to,d.depth)){const x=g.kind==="ref"?f.has(g.name)?"cte":"table":g.kind,k=E(g.name,x);if(k===d.id)continue;const T=h.find(A=>A.from===k&&A.to===d.id);T?(T.keys.length||(T.keys=g.keys),T.joinType||(T.joinType=g.joinType),T.nested=T.nested&&g.nested):h.push({from:k,to:d.id,joinType:g.joinType,keys:g.keys,nested:g.nested})}return{nodes:[...u.values()],edges:h}}function layout(t){const{nodes:e,edges:o}=t,n=new Map(e.map(r=>[r.id,[]])),i=new Map(e.map(r=>[r.id,[]]));for(const r of o)n.has(r.to)&&n.get(r.to).push(r.from),i.has(r.from)&&i.get(r.from).push(r.to);const s=new Map(e.map(r=>[r.id,0]));for(let r=0;r<e.length+1;r++){let p=!1;for(const m of e){const S=n.get(m.id);if(!S.length)continue;const N=Math.max(...S.map(I=>s.get(I)||0))+1;N>s.get(m.id)&&(s.set(m.id,N),p=!0)}if(!p)break}const c=Math.max(0,...e.map(r=>s.get(r.id))),a=new Map(e.map(r=>[r.id,i.get(r.id).length?1/0:c]));for(let r=0;r<e.length+1;r++){let p=!1;for(const m of e){const S=i.get(m.id);if(!S.length)continue;const N=Math.min(...S.map(I=>a.get(I)));N-1<a.get(m.id)&&(a.set(m.id,N-1),p=!0)}if(!p)break}for(const r of e)Number.isFinite(a.get(r.id))||a.set(r.id,c);const l=[];for(const r of e){const p=Math.max(0,a.get(r.id));(l[p]||(l[p]=[])).push(r)}const f=new Map;l.forEach((r,p)=>{r&&(p>0&&r.sort((m,S)=>{const N=I=>{const R=n.get(I.id).filter(O=>f.has(O));return R.length?R.reduce((O,b)=>O+f.get(b),0)/R.length:Number.MAX_SAFE_INTEGER};return N(m)-N(S)}),r.forEach((m,S)=>f.set(m.id,S)))});const u=boxWidth(e),h=new Map;l.forEach((r,p)=>(r||[]).forEach(m=>h.set(m.id,p)));const E=new Array(Math.max(0,l.length-1)).fill(GAP_MIN);for(const r of o){const p=(h.get(r.to)||0)-1;p<0||p>=E.length||(E[p]=Math.max(E[p],linesWidth(edgeLines(r))+22))}const F=[];let d=PAD;for(let r=0;r<l.length;r++)F[r]=d,d+=u+(E[r]||0);const g=[];l.forEach((r,p)=>{(r||[]).forEach((m,S)=>{g.push(w(y({},m),{x:F[p],y:PAD+S*(BOX_H+GAP_Y),w:u,h:BOX_H}))})});const x=new Map(g.map(r=>[r.id,r])),k=Math.max(1,...l.map(r=>(r||[]).length));let T=0,A=PAD*2+k*BOX_H+Math.max(0,k-1)*GAP_Y+6;for(const r of o){const p=x.get(r.from),m=x.get(r.to);if(!p||!m)continue;const S=edgeLines(r);if(!S.length)continue;const N=(p.y+p.h/2+m.y+m.h/2)/2,I=S.length*LINE_H;T=Math.min(T,N-I/2-PAD),A=Math.max(A,N+I/2+PAD)}return{nodes:g,edges:o.map(r=>w(y({},r),{a:x.get(r.from),b:x.get(r.to)})).filter(r=>r.a&&r.b),gaps:E,colOf:h,y0:T,width:(F[l.length-1]||PAD)+u+PAD,height:A-T}}const KIND={table:{text:"\u5B9F\u30C6\u30FC\u30D6\u30EB",fill:"#FFFFFF",stroke:"#8C6D3F",bar:"#C9A227"},cte:{text:"CTE",fill:"#FFFFFF",stroke:"#3F6D8C",bar:"#4E8FBF"},output:{text:"\u6700\u7D42 SELECT",fill:"#FFFFFF",stroke:"#6D3F8C",bar:"#8250DF"},subquery:{text:"\u30B5\u30D6\u30AF\u30A8\u30EA",fill:"#FFFFFF",stroke:"#6E7781",bar:"#9AA4AE"}},kindOf=t=>KIND[t]||KIND.subquery;function shortName(t){const e=String(t).replace(/`/g,""),o=e.lastIndexOf(".");return o>=0?e.slice(o+1):e}function boxWidth(t){let e=BOX_W_MIN;for(const o of t)e=Math.max(e,shortName(o.label).length*NAME_CHAR_W+24);return Math.min(e,BOX_W_MAX)}function fit(t,e){const o=String(t),n=Math.floor((e-24)/NAME_CHAR_W);return o.length>n?o.slice(0,n-1)+"\u2026":o}function edgeLines(t){const e=[];t.joinType&&e.push(t.joinType==="INNER"?"JOIN":t.joinType+" JOIN");for(const o of t.keys||[])e.push(o);return!e.length&&t.nested&&e.push("\u30B5\u30D6\u30AF\u30A8\u30EA"),e}function linesWidth(t){let e=0;for(const o of t)e=Math.max(e,o.length*CHAR_W);return e}function edgeLabel(t){const e=edgeLines(t);return e.length?e.length>1?e[0]+" / "+e.slice(1).join(", "):e[0]:""}function toSvg(t){const e=[];e.push(`<svg viewBox="0 ${(t.y0||0).toFixed(1)} ${t.width} ${t.height}" width="${t.width}" height="${t.height}" role="img" aria-label="\u53C2\u7167\u95A2\u4FC2\u56F3" xmlns="http://www.w3.org/2000/svg">`),e.push('<defs><marker id="vgarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8C96A0"/></marker></defs>');const o=[];for(const n of t.edges){const i=n.a.x+n.a.w,s=n.a.y+n.a.h/2,c=n.b.x,a=n.b.y+n.b.h/2,l=t.gaps&&t.gaps[(t.colOf.get(n.to)||0)-1]||GAP_MIN,f=c>i?c-l/2:i+l/2,u=`M${i},${s} H${f} V${a} H${c}`,h=edgeLines(n);e.push(`<path d="${u}" fill="none" stroke="#8C96A0" stroke-width="1.2" ${n.nested?'stroke-dasharray="4 3" ':""}marker-end="url(#vgarrow)">`+(h.length?`<title>${esc(edgeLabel(n))}</title>`:"")+"</path>"),h.length&&o.push({x:f,y:(s+a)/2,lines:h})}for(const n of o){const i=linesWidth(n.lines)+12,s=n.lines.length*LINE_H,c=n.y-s/2;e.push(`<rect x="${(n.x-i/2).toFixed(1)}" y="${c.toFixed(1)}" width="${i.toFixed(1)}" height="${s}" rx="2" fill="#FFFFFF" opacity="0.92"/>`);const a=n.lines.map((l,f)=>`<tspan x="${n.x}" y="${(c+LINE_H*f+11).toFixed(1)}">${esc(l)}</tspan>`).join("");e.push(`<text text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" fill="#57606A">${a}</text>`)}for(const n of t.nodes){const i=kindOf(n.kind),s=n.label+(n.params.length?`
`+n.params.map(c=>c.name+": "+Object.keys(c.values).map(a=>a+" = "+c.values[a]).join(" / ")).join(`
`):"");e.push(`<g><title>${esc(s)}</title>`),e.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5" fill="${i.fill}" stroke="${i.stroke}" stroke-width="1"/>`),e.push(`<rect x="${n.x}" y="${n.y}" width="4" height="${n.h}" rx="2" fill="${i.bar}"/>`),e.push(`<text x="${n.x+11}" y="${n.y+17}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" font-weight="600" fill="#24292F">${esc(fit(shortName(n.label),n.w))}</text>`),e.push(`<text x="${n.x+11}" y="${n.y+31}" font-family="Roboto,system-ui,sans-serif" font-size="9" fill="#8C96A0">${esc(i.text)}${n.params.length?" \u30FB\u30D1\u30E9\u30E1\u30FC\u30BF":""}</text>`),e.push("</g>")}return e.push("</svg>"),e.join("")}function groupSvg(t){return toSvg(layout(buildGraph(t.sql,t.params)))}function erdStack(t){return t.map(e=>`<div class="vg-erdblock"><div class="vg-erdhead"><span class="vg-erdname">${esc(label(e))}</span><span class="vg-tabn">${e.members.length}</span></div><div class="vg-erdbox">${groupSvg(e)}</div></div>`).join("")}function erdLegend(){const t=(e,o)=>`<span class="vg-lg"><span class="vg-lgm ${e}"></span>${esc(o)}</span>`;return'<div class="vg-legend">'+t("vg-lgt","\u5B9F\u30C6\u30FC\u30D6\u30EB")+t("vg-lgc","CTE")+t("vg-lgo","\u6700\u7D42 SELECT")+'<span class="vg-lg"><span class="vg-lgd"></span>\u30B5\u30D6\u30AF\u30A8\u30EA\u7D4C\u7531\u306E\u53C2\u7167</span></div>'}function renderErd(t){return t.groups.length?notice("FROM / JOIN \u304B\u3089\u8D77\u3053\u3057\u305F\u53C2\u7167\u95A2\u4FC2\u3067\u3059\u3002\u77E2\u5370\u306F\u300C\u8AAD\u3093\u3067\u4F5C\u308B\u300D\u5411\u304D\u3001\u6CE8\u8A18\u306F JOIN \u306E\u7A2E\u5225\u3068\u7D50\u5408\u30AD\u30FC\u3002\u30AB\u30FC\u30C7\u30A3\u30CA\u30EA\u30C6\u30A3\u3068\u4E3B\u30AD\u30FC\u306F SQL \u304B\u3089\u306F\u5206\u304B\u3089\u306A\u3044\u306E\u3067\u63CF\u3044\u3066\u3044\u307E\u305B\u3093\u3002\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u540D\u524D\u306F\u3001\u305D\u306E\u30B0\u30EB\u30FC\u30D7\u306E\u5148\u982D\u306E View \u306E\u5024\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002")+erdLegend()+erdStack(t.groups):notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002")}function renderErdBase(t){return'<div class="vg-root">'+header(t.base,t.viewCount,t.groups.length,t.unmatched)+renderErd(t)+"</div>"}function __opts(t){if(!t)return{};try{return JSON.parse(t)||{}}catch(e){return{}}}function __notice(t){return'<div class="vg-notice">'+String(t).replace(/[<>&]/g,"")+"</div>"}function __run(t,e){var o;try{o=JSON.parse(t)}catch(c){o=null}if(!o)return __notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002");for(var n="",i=o.bases||[],s=0;s<i.length;s++)n+=renderErdBase(i[s]);return n||__notice("\u56F3\u306B\u3067\u304D\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002")}return __run(analysis_json,options_json);

""";

DECLARE js_page STRING DEFAULT r"""
const MAX_TABS=12,MAX_REF_TABS=12,MAX_SQL_TABS=24,MAX_DESC_TABS=16,REF_BUDGET=41943040,OUTER_TABS=["note","\u30AB\u30E9\u30E0\u5B9A\u7FA9","\u53C2\u7167\u95A2\u4FC2","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","SQL"],MAX_OUTER_TABS=8,NOTE_MARK="<!--VG_NOTE-->",CSS_GEN=3;function cssGuard(){return`<div class="vg-cssgen3" style="margin:0 0 10px;padding:8px 12px;border:1px solid #D4A72C;border-radius:6px;background:#FFF8C5;color:#7D4E00;font:12px/1.6 'Roboto','Segoe UI',system-ui,sans-serif">\u3053\u306E\u30AB\u30FC\u30C9\u306B\u306F\u65B0\u3057\u3044 CSS\uFF08\u4E16\u4EE3 3\uFF09\u304C\u8981\u308A\u307E\u3059\u3002template_style.html \u3092\u8CBC\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u8CBC\u308A\u66FF\u3048\u308B\u307E\u3067\u3001\u30BF\u30D6\u304C\u5207\u308A\u66FF\u308F\u3089\u305A\u4E2D\u8EAB\u304C\u5168\u90E8\u540C\u6642\u306B\u51FA\u307E\u3059\u3002</div>`}function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(s){let n=2166136261;for(let e=0;e<String(s).length;e++)n^=String(s).charCodeAt(e),n=Math.imul(n,16777619)>>>0;return n.toString(36)}const label=s=>s.suffixes.map((n,e)=>n||s.members[e]&&s.members[e].viewName||"(suffix \u306A\u3057)").join(", ");function badge(s,n,e){return`<span class="vg-badge" style="color:${n};background:${e}">${esc(s)}</span>`}function header(s,n,e,l){const o=e>1;return`<div class="vg-header"><span class="vg-title">${esc(s)}</span>`+badge(`${n} View`,"#57606A","#EAEEF2")+badge(`${e} \u30B0\u30EB\u30FC\u30D7`,o?"#9A6700":"#1A7F37",o?"#FFF8C5":"#DAFBE1")+(l?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(s){return`<div class="vg-notice">${esc(s)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=s=>KIND_TEXT[s]||s;function wrapPage(s,n,e,l,o,i){const t=i||{},r="vgo"+hashId(t.base||""),u=[`<div class="vg-root">${o==null||o===""?NOTE_MARK:String(o)}</div>`,e,n,s,l],a=OUTER_TABS.map((f,g)=>`<input class="vg-or vg-or${g+1}" type="radio" name="${r}" id="${r}-${g+1}"${g===0?" checked":""}>`).join(""),d=OUTER_TABS.map((f,g)=>`<label class="vg-otab vg-ot${g+1}" for="${r}-${g+1}">${esc(f)}</label>`).join(""),p=OUTER_TABS.map((f,g)=>`<div class="vg-opanel vg-op${g+1}">${u[g]||""}</div>`).join(""),m=t.base?header(t.base,t.viewCount,(t.groups||[]).length,t.unmatched):"";return`<div class="vg-outer">${cssGuard()}${a}<div class="vg-otablist">${m}${d}</div><div class="vg-opanels">${p}</div></div>`}const WARN="\u26A0",MAX_TABLE_W=1e3,MIN_COL_W=150,NAME_COL_W=180;function breakType(s){return String(s).replace(/(&lt;|,)/g,"$1<wbr>")}const DESC_JA_KEYS=["ja","jp","ja_name","name_ja","japanese","logical_name_ja","logicalNameJa","ja_logical_name","\u548C\u540D","\u65E5\u672C\u8A9E","\u65E5\u672C\u8A9E\u8AD6\u7406\u540D","\u8AD6\u7406\u540D"],DESC_EN_KEYS=["en","en_name","name_en","english","logical_name_en","logicalNameEn","en_logical_name","\u82F1\u8A9E","\u82F1\u8A9E\u8AD6\u7406\u540D"];function pickKey(s,n){for(let e=0;e<n.length;e++){const l=n[e];if(!Object.prototype.hasOwnProperty.call(s,l))continue;const o=s[l];if(!(o==null||String(o)===""))return{key:l,value:String(o)}}return null}function parseDesc(s){const n=String(s==null?"":s).trim();if(!n)return null;if(n.charAt(0)!=="{")return{raw:n};let e=null;try{e=JSON.parse(n)}catch(u){e=null}if(!e||typeof e!="object"||Array.isArray(e))return{raw:n};const l=pickKey(e,DESC_JA_KEYS),o=pickKey(e,DESC_EN_KEYS),i={};l&&(i[l.key]=!0),o&&(i[o.key]=!0);const t=[],r=Object.keys(e);for(let u=0;u<r.length;u++){const a=r[u];if(i[a])continue;const d=e[a];d==null||d===""||t.push({key:a,value:typeof d=="object"?JSON.stringify(d):String(d)})}const c=[];l&&c.push(l),o&&c.push(o);for(let u=0;u<t.length;u++)c.push(t[u]);return{ja:l?l.value:"",en:o?o.value:"",rest:t,pairs:c}}function descHtml(s){const n=parseDesc(s);return n?n.raw?`<div class="vg-cdesc">${esc(n.raw)}</div>`:n.pairs.length?`<table class="vg-cdtable">${n.pairs.map(l=>`<tr><th class="vg-cdk">${esc(l.key)}</th><td class="vg-cdv">${esc(l.value)}</td></tr>`).join("")}</table>`:"":""}function structFields(s){const n=String(s==null?"":s),e=n.indexOf("STRUCT<");if(e<0)return[];const l=[];let o="",i=0;for(let r=e+7;r<n.length;r++){const c=n.charAt(r);if(c===">"&&i===0){l.push(o);break}if(c==="<")i++;else if(c===">")i--;else if(c===","&&i===0){l.push(o),o="";continue}o+=c}const t=[];for(let r=0;r<l.length;r++){const c=l[r].trim().split(/[\s<]/)[0];c&&t.push(c)}return t}function assignOrder(s){const n=e=>("000"+e).slice(-4);for(const e of s.values()){const l=e.name.split("."),o=s.get(l[0]),i=o&&o.vals[0]&&o.vals[0].ord!=null?o.vals[0].ord:9999;let t=n(i),r=l[0];for(let c=1;c<l.length;c++){const u=s.get(r),d=(u&&u.vals[0]?structFields(u.vals[0].type):[]).indexOf(l[c]);t+="."+n(d<0?9999:d),r+="."+l[c]}e.sortKey=t}}function typeShape(s){const n=String(s==null?"":s).trim(),e=n.slice(0,6).toUpperCase()==="ARRAY<";let l=n;e&&(l=n.slice(n.indexOf("<")+1,n.lastIndexOf(">")).trim());const o=l.slice(0,7).toUpperCase()==="STRUCT<";return{repeated:e,record:o,name:o?"RECORD":l}}const isNested=s=>String(s).indexOf(".")>=0;function columnSig(s){const n=(s||[]).map(e=>[String(e.n==null?"":e.n),String(e.t==null?"":e.t),e.u==null||e.u===""?"":String(e.u).toUpperCase(),String(e.d==null?"":e.d)].join("\u0001"));return n.sort(),n.join("\u0002")}function columnGroups(s,n){const e=new Map,l=[],o=s&&s.groups||[];for(let t=0;t<o.length;t++){const r=o[t],c=r.members||[];for(let u=0;u<c.length;u++){const a=c[u],d=columnSig(n[a.viewName]);let p=e.get(d);p||(p={suffixes:[],members:[]},e.set(d,p),l.push(p)),p.suffixes.push((r.suffixes&&r.suffixes[u])!=null?r.suffixes[u]:null),p.members.push(a)}}const i=t=>String(t.suffixes[0]==null?t.members[0].viewName:t.suffixes[0]);for(const t of l){const r=t.members.map((c,u)=>u).sort((c,u)=>{const a=String(t.suffixes[c]==null?t.members[c].viewName:t.suffixes[c]),d=String(t.suffixes[u]==null?t.members[u].viewName:t.suffixes[u]);return a<d?-1:a>d?1:0});t.suffixes=r.map(c=>t.suffixes[c]),t.members=r.map(c=>t.members[c])}return l.sort((t,r)=>r.members.length-t.members.length||(i(t)<i(r)?-1:i(t)>i(r)?1:0)),l}function descCell(s){return!s||!s.descs.length?"":s.descs.length===1?descHtml(s.descs[0].text):s.descs.map(n=>`<div class="vg-cdescwho">${esc(n.suffixes.join(", "))}</div>`+descHtml(n.text)).join("")}function groupColumns(s,n){const e=new Map,l=s.members||[];for(let o=0;o<l.length;o++){const i=l[o],t=s.suffixes&&s.suffixes[o]||i.viewName,r=n[i.viewName]||[];for(let c=0;c<r.length;c++){const u=r[c];let a=e.get(u.n);if(a||(a={name:u.n,descs:[],order:c,vals:[]},e.set(u.n,a)),u.d){const d=String(u.d);let p=null;for(let m=0;m<a.descs.length;m++)a.descs[m].text===d&&(p=a.descs[m]);p?p.suffixes.push(t):a.descs.push({text:d,suffixes:[t]})}a.vals.push({suffix:t,type:u.t,ord:u.o==null?c+1:u.o,nullable:u.u==null||u.u===""?null:String(u.u).toUpperCase()!=="NO"})}}return assignOrder(e),e}function columnOrder(s){const n=new Set,e=[];for(const l of s){const o=[...l.values()].sort((i,t)=>i.sortKey<t.sortKey?-1:i.sortKey>t.sortKey?1:0);for(const i of o)n.has(i.name)||(n.add(i.name),e.push(i.name))}return e}function majority(s){const n=new Map;for(const o of s)n.set(o,(n.get(o)||0)+1);let e=null,l=-1;for(const o of s){const i=n.get(o);i>l&&(e=o,l=i)}return e}const nullText=s=>s===null?"UNKNOWN":s?"NULLABLE":"REQUIRED";function uniq(s){const n=[];for(const e of s)n.indexOf(e)<0&&n.push(e);return n}function cellInfo(s,n){if(!s)return{text:null,meta:"",sig:null,mixed:!1};const e=uniq(s.vals.map(r=>r.type)),l=uniq(s.vals.map(r=>nullText(r.nullable))),o=uniq(s.vals.map(r=>String(r.ord))).length>1||s.vals.length!==n,i=s.vals.map(r=>typeShape(r.type)),t=s.descs.map(r=>r.text).join("\u0001");return{text:e.join(" / "),shape:uniq(i.map(r=>r.name)).join(" / "),repeated:i.length>0&&i.every(r=>r.repeated),record:i.some(r=>r.record),nulls:l.join(" / "),sig:e.join(" / ")+"|"+l.join(" / ")+"|"+t,mixed:o}}function mixedTip(s,n){const e=isNested(s.name),l=s.vals.map(i=>e?`${i.suffix} = ${i.type}`:`${i.suffix} = #${i.ord} ${i.type} ${nullText(i.nullable)}`),o=s.vals.map(i=>i.suffix);for(let i=0;i<(n.members||[]).length;i++){const t=n.suffixes&&n.suffixes[i]||n.members[i].viewName;o.indexOf(t)<0&&l.push(`${t} = (\u3053\u306E\u5217\u3092\u6301\u305F\u306A\u3044)`)}return l.join(`
`)}function renderColumns(s,n){if(!(s.groups||[]).length)return notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");const e=columnGroups(s,n||{}),l=e.map(f=>groupColumns(f,n||{})),o=columnOrder(l);if(!o.length)return notice("\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.COLUMNS \u304B\u3089\u5217\u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");const i=new Set;for(const f of o){const g=f.lastIndexOf(".");g>0&&i.add(f.slice(0,g))}let t=0,r=0;const c=o.map(f=>{const g=f.split("."),h=g.length-1,S=h>0,$=e.map((v,w)=>cellInfo(l[w].get(f),v.members.length)),b=majority($.map(v=>v.sig));$.some(v=>v.sig!==b)&&t++;const x=$.map((v,w)=>{const O=e[w],N=l[w].get(f),_=["vg-ccell"];v.text?v.sig!==b&&_.push("vg-cdiff"):_.push("vg-cnone"),v.mixed&&(_.push("vg-cmix"),r++);const C=!v.record||i.has(f)?v.shape:v.text,j=S?v.repeated?"REPEATED":"":v.repeated?"REPEATED":v.nulls,T=v.text?breakType(esc(C))+(v.mixed?`<span class="vg-cwarn" data-tip="${esc(mixedTip(N,O))}">${WARN}</span>`:"")+(j?`<span class="vg-cmeta">${esc(j)}</span>`:"")+descCell(N):"\u2014";return`<td class="${_.join(" ")}">${T}</td>`}).join(""),y="vg-cname"+(h?` vg-cd${Math.min(h,3)}`:""),E=h?`<span class="vg-cnestmark">\u2514</span>${esc(g[g.length-1])}`:esc(f);return`<tr><th class="${y}">${E}</th>${x}</tr>`}).join(""),u=e.map(f=>`<th class="vg-chead">${esc(label(f))}<span class="vg-tabn">${f.members.length}</span></th>`).join(""),a=[];e.length===1?a.push(notice(`${s.viewCount||e[0].members.length} \u672C\u306E View \u3059\u3079\u3066\u3067\u30AB\u30E9\u30E0\u5B9A\u7FA9\uFF08\u5217\u540D\u30FB\u578B\u30FB\u30E2\u30FC\u30C9\u30FB\u8AAC\u660E\uFF09\u304C\u4E00\u81F4\u3057\u3066\u3044\u307E\u3059\u3002`)):(a.push(notice(`\u30AB\u30E9\u30E0\u5B9A\u7FA9\u304C ${e.length} \u7A2E\u985E\u3042\u308A\u307E\u3059\uFF08\u5217\u304C\u305D\u306E\u672C\u6570\uFF09\u3002\u5217\u306F\u30ED\u30B8\u30C3\u30AF \u30B0\u30EB\u30FC\u30D7\u3067\u306F\u306A\u304F\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3067\u675F\u306D\u3066\u3044\u308B\u306E\u3067\u3001SQL \u304C\u540C\u4E00\u3067\u3082\u53C2\u7167\u5148\u30C6\u30FC\u30D6\u30EB\u306E\u578B\u3084 description \u304C\u9055\u3048\u3070\u5225\u306E\u5217\u306B\u306A\u308A\u307E\u3059\uFF08\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206\u306E\u30BF\u30D6\u306B\u306F\u51FA\u3066\u3053\u306A\u3044\u5DEE\u3067\u3059\uFF09\u3002`)),t&&a.push(notice(`\u578B\u30FB\u30E2\u30FC\u30C9\u30FB\u8AAC\u660E\u306E\u3044\u305A\u308C\u304B\u304C\u63C3\u3063\u3066\u3044\u306A\u3044\u5217\u304C ${t} \u4EF6\u3042\u308A\u307E\u3059\uFF08\u8272\u4ED8\u304D\u306E\u30BB\u30EB\u3002\u305D\u306E\u5217\u3067\u3044\u3061\u3070\u3093\u591A\u3044\u5185\u5BB9\u3068\u9055\u3046\u3082\u306E\uFF09\u3002`))),r&&a.push(notice(`\u540C\u3058\u5217\u306E\u4E2D\u3067\u4E26\u3073\u9806\uFF08ordinal\uFF09\u3060\u3051\u304C\u98DF\u3044\u9055\u3063\u3066\u3044\u308B\u7B87\u6240\u304C${r} \u4EF6\u3042\u308A\u307E\u3059\uFF08${WARN} \u306E\u5370\u3002\u30DB\u30D0\u30FC\u3059\u308B\u3068 suffix \u3054\u3068\u306E\u5185\u8A33\u304C\u51FA\u307E\u3059\uFF09\u3002\u4E26\u3073\u9806\u306F\u5217\u306E\u675F\u306D\u65B9\u306B\u3082\u8868\u306E\u4E2D\u8EAB\u306B\u3082\u4F7F\u3063\u3066\u3044\u306A\u3044\u306E\u3067\u3001\u3053\u3053\u306B\u3060\u3051\u51FA\u307E\u3059\u3002`));const d=`<colgroup><col style="width:${NAME_COL_W}px">`+e.map(()=>"<col>").join("")+"</colgroup>",p=NAME_COL_W+MIN_COL_W*e.length,m=p>MAX_TABLE_W?` style="min-width:${p}px"`:"";return a.join("")+`<div class="vg-ctablewrap"><table class="vg-ctable"${m}>${d}<thead><tr><th class="vg-chead vg-cnamehead">\u5217\u540D</th>${u}</tr></thead><tbody>${c}</tbody></table></div>`}function renderColumnsBase(s,n){return`<div class="vg-root">${renderColumns(s,n)}</div>`}function sqlViews(s){const n=[],e=s.groups||[];for(let l=0;l<e.length;l++){const o=e[l],i=o.members||[];for(let t=0;t<i.length;t++)n.push({suffix:o.suffixes&&o.suffixes[t]||i[t].viewName||"(suffix \u306A\u3057)",viewName:i[t].viewName,group:label(o),groupSize:i.length})}return n.sort((l,o)=>String(l.suffix).localeCompare(String(o.suffix))),n}function sqlBody(s){const n=String(s).replace(/\r\n?/g,`
`).split(`
`);for(;n.length>1&&n[n.length-1].trim()==="";)n.pop();const e=String(n.length).length;return{html:`<div class="vg-sqlbox"><pre class="vg-sqlpre">${n.map((o,i)=>{const t=String(i+1);return`<span class="vg-sqln">${new Array(e-t.length+1).join(" ")}${t}</span> `+esc(o)}).join(`
`)}</pre></div>`,lines:n.length}}function sqlPanel(s,n){if(n==null||String(n)==="")return`<div class="vg-sqlhead"><span class="vg-sqlname">${esc(s.viewName)}</span></div>`+notice("\u3053\u306E View \u306E SQL \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");const e=sqlBody(n);return`<div class="vg-sqlhead"><span class="vg-sqlname">${esc(s.viewName)}</span><span class="vg-sqlmeta">\u30B0\u30EB\u30FC\u30D7: ${esc(s.group)}</span><span class="vg-sqlmeta">${e.lines} \u884C</span></div>`+e.html}function renderSql(s,n){const e=sqlViews(s);if(!e.length)return notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");const l=n||{};if(!e.some(a=>l[a.viewName]))return notice("SQL \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.VIEWS \u304B\u3089 view_definition \u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");const o=e.slice(0,24),i="vgs"+hashId(s.base+"|"+e.map(a=>a.viewName).join("|")),t=o.map((a,d)=>`<input class="vg-sr vg-sr${d+1}" type="radio" name="${i}" id="${i}-${d+1}"${d===0?" checked":""}>`).join(""),r=o.map((a,d)=>`<label class="vg-stab vg-st${d+1}" for="${i}-${d+1}">${esc(a.suffix)}</label>`).join(""),c=o.map((a,d)=>`<div class="vg-spanel vg-sp${d+1}">${sqlPanel(a,l[a.viewName])}</div>`).join("");return(e.length>o.length?notice(`View \u304C\u591A\u3044\u305F\u3081\u5148\u982D 24 \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${e.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-stabs">${t}<div class="vg-stablist"><span class="vg-slabel">View</span>${r}</div><div class="vg-spanels">${c}</div></div>`}function renderSqlBase(s,n){return`<div class="vg-root">${renderSql(s,n)}</div>`}const DESC_TAB_ON="background:#EAEEF2;border-color:#8C959F;color:#24292F";function suffixByView(s){const n={},e=s&&s.groups||[];for(let l=0;l<e.length;l++){const o=e[l],i=o.members||[];for(let t=0;t<i.length;t++){const r=i[t]&&i[t].viewName;r&&(n[r]=o.suffixes&&o.suffixes[t]||r)}}return n}function descGroups(s,n){const e=Array.isArray(n)?n:[],l=suffixByView(s),o=[];for(let i=0;i<e.length;i++){const t=e[i]||{},r=Array.isArray(t.v)?t.v:t.v==null||t.v===""?[]:[t.v],c=r.map(a=>l[a]||a).sort((a,d)=>a<d?-1:a>d?1:0),u=String(t.h==null?"":t.h);o.push({label:c.join(", ")||"(View \u306A\u3057)",count:r.length,html:u,empty:u.trim()===""})}return o.sort((i,t)=>(i.empty===t.empty?0:i.empty?1:-1)||t.count-i.count||(i.label<t.label?-1:i.label>t.label?1:0)),o}function descPanel(s){return s.empty?notice("description \u304C\u8A2D\u5B9A\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"):s.html}const tabText=s=>`${esc(s.label)}<span class="vg-tabn">${s.count}</span>`;function renderDesc(s,n){const e=descGroups(s,n),l='<div class="vg-nhead">View \u306E description</div>';if(!e.length)return`<div class="vg-nsec">${l}`+notice("View \u306E description \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.TABLE_OPTIONS \u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002")+"</div>";if(e.length===1)return`<div class="vg-nsec">${l}<div class="vg-dtablist"><span class="vg-dtab vg-dstatic">${tabText(e[0])}</span></div><div class="vg-dbox">${descPanel(e[0])}</div></div>`;const o=e.slice(0,16),i="vgd"+hashId((s&&s.base||"")+"|"+e.map(a=>a.label).join("|")),t=o.map((a,d)=>`<input class="vg-dr vg-dr${d+1}" type="radio" name="${i}" id="${i}-${d+1}"${d===0?" checked":""}>`).join(""),r=o.map((a,d)=>`<label class="vg-dtab vg-dt${d+1}" for="${i}-${d+1}">${tabText(a)}</label>`).join(""),c=o.map((a,d)=>`<div class="vg-dpanel vg-dp${d+1}">${descPanel(a)}</div>`).join(""),u=e.length>o.length?notice(`description \u304C\u591A\u3044\u305F\u3081\u5148\u982D 16 \u7A2E\u985E\u306E\u307F\u51FA\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${e.length} \u7A2E\u985E\uFF09\u3002`):"";return`<div class="vg-nsec">${l}${u}<div class="vg-dtabs">${t}<div class="vg-dtablist">${r}</div><div class="vg-dpanels">${c}</div></div></div>`}function renderNote(s,n,e){const l=String(e==null?"":e);return renderDesc(s,n)+`<div class="vg-nsec"><div class="vg-nhead">\u30E1\u30E2</div>${l}</div>`}function __opts(s){if(!s)return{};try{return JSON.parse(s)||{}}catch(n){return{}}}function __notice(s){return'<div class="vg-notice">'+String(s).replace(/[<>&]/g,"")+"</div>"}function __run(s,n,e,l,o,i,t){var r=__opts(t),c;try{c=JSON.parse(s)}catch(x){c=null}if(!c)return String(n||__notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002"));var u={};try{for(var a=JSON.parse(l)||[],d=0;d<a.length;d++)u[a[d].v]=a[d].cols||[]}catch(x){u={}}var p={};try{for(var m=JSON.parse(o)||[],f=0;f<m.length;f++)p[m[f].v]=m[f].s}catch(x){p={}}var g=[];try{g=JSON.parse(i)||[]}catch(x){g=[]}for(var h="",S="",$=c.bases||[],b=0;b<$.length;b++)h+=renderColumnsBase($[b],u),S+=renderSqlBase($[b],p);h||(h=__notice("\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3092\u51FA\u305B\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002")),S||(S=__notice("SQL \u3092\u51FA\u305B\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002"));var A=c.bases&&c.bases.length?c.bases[0]:null;return wrapPage(String(n||""),String(e||__notice("\u53C2\u7167\u95A2\u4FC2\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002")),h,S,renderNote(A,g,NOTE_MARK),A)}return __run(analysis_json,diff_html,erd_html,columns_json,sql_json,descs_json,options_json);

""";
DECLARE js_markdown STRING DEFAULT r"""
const MD_MARK="\u0002";function mdEsc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function mdUrl(e){const n=String(e==null?"":e).replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&amp;/g,"&").trim();return/^(https?:\/\/|mailto:)/i.test(n)?mdEsc(n):null}function mdLink(e,n){const t=mdUrl(e);return t?`<a class="vg-mda" href="${t}" target="_blank" rel="noopener noreferrer">${n}</a>`:n}function mdInline(e){const n=[];let t=String(e==null?"":e).replace(/`([^`]+)`/g,(d,l)=>(n.push(l),"\u0002"+(n.length-1)+"\u0002"));return t=mdEsc(t),t=t.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,(d,l,r)=>mdLink(r,l||r)),t=t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g,(d,l,r)=>mdLink(r,l)),t=t.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/g,(d,l,r)=>l+mdLink(r,r)),t=t.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>"),t=t.replace(/\*([^*\n]+)\*/g,"<em>$1</em>"),t=t.replace(/~~([^~\n]+)~~/g,"<del>$1</del>"),t.replace(new RegExp("\u0002(\\d+)\u0002","g"),(d,l)=>`<code class="vg-mdcode">${mdEsc(n[Number(l)])}</code>`)}function mdIndent(e){return(String(e).match(/^[\t ]*/)[0]||"").replace(/\t/g,"  ").length}const MD_FENCE=/^ {0,3}(`{3,}|~{3,})\s*[^`]*$/,MD_HEAD=/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,MD_HR=/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/,MD_QUOTE=/^ {0,3}>/,MD_LI=/^([\t ]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/,MD_DELIM=/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;function mdKind(e,n){const t=e[n];return!t||!t.trim()?"blank":MD_FENCE.test(t)?"fence":MD_HEAD.test(t)?"head":t.indexOf("|")>=0&&n+1<e.length&&MD_DELIM.test(e[n+1])?"table":MD_HR.test(t)?"hr":MD_QUOTE.test(t)?"quote":MD_LI.test(t)?"list":"p"}function mdCells(e){let n=String(e).trim();return n.charAt(0)==="|"&&(n=n.slice(1)),n.charAt(n.length-1)==="|"&&(n=n.slice(0,-1)),n.split("|").map(t=>t.trim())}function mdAligns(e){return mdCells(e).map(n=>{const t=n.charAt(0)===":",d=n.charAt(n.length-1)===":";return t&&d?" vg-mdtc":d?" vg-mdtr":t?" vg-mdtl":""})}function mdList(e,n){const t=e[n].indent,d=e[n].ordered,l=d?"ol":"ul";let r=`<${l} class="vg-md${l}">`,o=n;for(;o<e.length&&e[o].indent===t&&e[o].ordered===d;){let i=e[o].text.map(mdInline).join("<br>");for(o++;o<e.length&&e[o].indent>t;){const g=mdList(e,o);i+=g.html,o=g.next}r+=`<li class="vg-mdli">${i}</li>`}return{html:r+`</${l}>`,next:o}}function mdBlocks(e){const n=[];let t=0;for(;t<e.length;){const d=mdKind(e,t);if(d==="blank"){t++;continue}if(d==="fence"){const r=e[t].match(MD_FENCE)[1],o=new RegExp("^ {0,3}"+r.charAt(0)+"{"+r.length+",}[ 	]*$"),i=[];for(t++;t<e.length&&!o.test(e[t]);)i.push(e[t++]);t<e.length&&t++,n.push(`<pre class="vg-mdpre"><code>${mdEsc(i.join(`
`))}</code></pre>`);continue}if(d==="head"){const r=e[t].match(MD_HEAD),o=r[1].length;n.push(`<h${o} class="vg-mdh${o}">${mdInline(r[2])}</h${o}>`),t++;continue}if(d==="table"){const r=mdAligns(e[t+1]),o=mdCells(e[t]).map((g,c)=>`<th class="vg-mdth${r[c]||""}">${mdInline(g)}</th>`).join("");t+=2;const i=[];for(;t<e.length&&e[t].indexOf("|")>=0&&e[t].trim();)i.push(`<tr>${mdCells(e[t]).map((g,c)=>`<td class="vg-mdtd${r[c]||""}">${mdInline(g)}</td>`).join("")}</tr>`),t++;n.push(`<div class="vg-mdtw"><table class="vg-mdtable"><thead><tr>${o}</tr></thead><tbody>${i.join("")}</tbody></table></div>`);continue}if(d==="hr"){n.push('<hr class="vg-mdhr">'),t++;continue}if(d==="quote"){const r=[];for(;t<e.length&&MD_QUOTE.test(e[t]);)r.push(e[t].replace(/^ {0,3}> ?/,"")),t++;n.push(`<blockquote class="vg-mdq">${mdBlocks(r)}</blockquote>`);continue}if(d==="list"){const r=[];for(;t<e.length&&e[t].trim();){const i=e[t].match(MD_LI);if(i)r.push({indent:mdIndent(i[1]),ordered:/\d/.test(i[2]),text:[i[3]]});else if(r.length&&mdIndent(e[t])>r[r.length-1].indent)r[r.length-1].text.push(e[t].trim());else break;t++}let o=0;for(;o<r.length;){const i=mdList(r,o);n.push(i.html),o=i.next}continue}const l=[];for(;t<e.length&&mdKind(e,t)==="p";)l.push(e[t++]);n.push(`<p class="vg-mdp">${l.map(mdInline).join("<br>")}</p>`)}return n.join("")}function mdRender(e){return mdBlocks(String(e==null?"":e).replace(/\r\n?/g,`
`).split(`
`))}function markdownHtml(e){const n=String(e==null?"":e);return n.trim()?`<div class="vg-md">${mdRender(n)}</div>`:'<div class="vg-md vg-mdempty">\u3053\u306E base \u306E\u30E1\u30E2\u306F\u307E\u3060\u767B\u9332\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002</div>'}function memoCss(){return[".vg-md{font:13px/1.75 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F;overflow-wrap:anywhere}",".vg-mdempty{color:#8C959F}",".vg-md>:first-child{margin-top:0}",".vg-md>:last-child,.vg-mdq>:last-child{margin-bottom:0}",".vg-mdh1{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A;margin:18px 0 8px}",".vg-mdh2{font-weight:600;font-size:14px;line-height:1.6;color:#1A1A1A;margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid #EAEEF2}",".vg-mdh3{font-weight:600;font-size:13px;line-height:1.6;color:#24292F;margin:14px 0 6px}",".vg-mdh4,.vg-mdh5,.vg-mdh6{font-weight:600;font-size:12px;line-height:1.6;color:#57606A;margin:12px 0 6px}",".vg-mdp{margin:0 0 10px}",".vg-mdul,.vg-mdol{margin:0 0 10px;padding-left:22px}",".vg-mdli{margin:2px 0}",".vg-mdli>.vg-mdul,.vg-mdli>.vg-mdol{margin:2px 0 0}",".vg-mdtw{overflow-x:auto;margin:0 0 12px}",".vg-mdtable{border-collapse:collapse;font-size:12px}",".vg-mdth{border:1px solid #D0D7DE;padding:5px 10px;background:#F6F8FA;font-weight:600;text-align:left;white-space:nowrap}",".vg-mdtd{border:1px solid #D0D7DE;padding:5px 10px;vertical-align:top}",".vg-mdtl{text-align:left}",".vg-mdtc{text-align:center}",".vg-mdtr{text-align:right}",".vg-mdpre{margin:0 0 12px;padding:10px 12px;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA;overflow-x:auto}",".vg-mdpre code{font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#24292F}",".vg-mdcode{padding:1px 5px;border-radius:3px;background:#EFF1F3;color:#24292F;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mdq{margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid #D0D7DE;color:#57606A}",".vg-mdhr{margin:14px 0;border:none;border-top:1px solid #D0D7DE}",".vg-mda{color:#0969DA;text-decoration:none}",".vg-mda:hover{text-decoration:underline}"].join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(n){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __run(e){try{return markdownHtml(e)}catch(n){return __notice("\u30E1\u30E2\u3092\u8868\u793A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F: "+n)}}return __run(md);

""";

-- CSS は本文そのもの（JavaScript ではない）。生成時に組み立ててここに焼き込む。
-- 中身は template_style.html と 1 バイトも違わない。
DECLARE css_text STRING DEFAULT r"""
.vg-cssgen3{display:none}
.vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}
.vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}
.vg-title{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A}
.vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}
.vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}
.vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}
.vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}
.vg-tab:hover{background:#EAEEF2;color:#24292F}
.vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}
.vg-tbase:hover{background:#fbeded;color:#24292F}
.vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}
.vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}
.vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}
.vg-panel{display:none}
.vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}
.vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}
.vg-pblock{padding:0 12px 10px}
.vg-plabel{font-weight:600;font-size:12px;line-height:1.8;color:#24292F}
.vg-pnone{color:#57606A;font-size:12px}
.vg-ptable{border-collapse:collapse;width:100%}
.vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-pvals{padding:3px 0}
.vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}
.vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}
.vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}
.vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font-weight:600;font-size:12px;line-height:1.6;color:#24292F;white-space:nowrap}
.vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}
.vg-mreason{padding:3px 0;color:#57606A;font-size:12px}
.vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}
.vg-ph{position:relative;margin:0 -2px;padding:0 2px;border-radius:3px;background:#F1E8FD;color:#6639BA;font-weight:700;box-shadow:inset 0 0 0 1px #CDB6F2;cursor:help}
.vg-ph:hover{background:#E4D3FB}
.vg-ph::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}
.vg-ph:hover::after{display:block}
.vg-ph.vg-phr::after{left:auto;right:0}
.vg-br{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-btablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px}
.vg-blabel{color:#57606A;font-size:12px;font-weight:600;margin-right:2px}
.vg-btab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid #D0D7DE;border-radius:14px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px}
.vg-btab:hover{background:#EAEEF2;color:#24292F}
.vg-bpanel{display:none}
.vg-or{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-outer{max-height:min(100vh,2000px);overflow:auto;--vg-bar:75px}
.vg-otablist,.vg-ohead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;position:sticky;top:0;z-index:5;background:#fff;margin:0 0 10px;padding:8px 0;box-shadow:0 1px 0 #EAEEF2}
.vg-otablist>.vg-header,.vg-ohead>.vg-header{flex:0 0 100%;margin:0}
.vg-ohead>.vg-otablist{position:static;padding:0;margin:0;box-shadow:none;flex:0 0 100%}
.vg-opanel .vg-header{display:none}
.vg-otab{display:inline-flex;align-items:center;padding:5px 16px;border:1px solid #D0D7DE;border-radius:16px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px}
.vg-otab:hover{background:#EAEEF2;color:#24292F}
.vg-opanel{display:none}
.vg-erdblock{margin:0 0 28px;border:1px solid #D0D7DE;border-radius:6px;background:#fff}
.vg-erdblock:last-child{margin-bottom:0}
.vg-erdhead{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid #EAEEF2;background:#F6F8FA;border-radius:6px 6px 0 0}
.vg-erdname{font-weight:600;color:#24292F;font-size:12px}
.vg-erdbox{overflow-x:auto;padding:6px 10px 10px}
.vg-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 10px;color:#57606A;font-size:11px}
.vg-lg{display:inline-flex;align-items:center;gap:5px}
.vg-lgm{display:inline-block;width:10px;height:10px;border-radius:2px;border:1px solid #8C96A0}
.vg-lgt{background:#C9A227;border-color:#8C6D3F}
.vg-lgc{background:#4E8FBF;border-color:#3F6D8C}
.vg-lgo{background:#8250DF;border-color:#6D3F8C}
.vg-lgd{display:inline-block;width:18px;border-top:1.5px dashed #8C96A0}
.vg-or1:checked ~ .vg-opanels > .vg-op1{display:block}
.vg-or1:checked ~ .vg-otablist > .vg-ot1,.vg-or1:checked ~ .vg-ohead > .vg-otablist > .vg-ot1{background:#24292F;border-color:#24292F;color:#fff}
.vg-or2:checked ~ .vg-opanels > .vg-op2{display:block}
.vg-or2:checked ~ .vg-otablist > .vg-ot2,.vg-or2:checked ~ .vg-ohead > .vg-otablist > .vg-ot2{background:#24292F;border-color:#24292F;color:#fff}
.vg-or3:checked ~ .vg-opanels > .vg-op3{display:block}
.vg-or3:checked ~ .vg-otablist > .vg-ot3,.vg-or3:checked ~ .vg-ohead > .vg-otablist > .vg-ot3{background:#24292F;border-color:#24292F;color:#fff}
.vg-or4:checked ~ .vg-opanels > .vg-op4{display:block}
.vg-or4:checked ~ .vg-otablist > .vg-ot4,.vg-or4:checked ~ .vg-ohead > .vg-otablist > .vg-ot4{background:#24292F;border-color:#24292F;color:#fff}
.vg-or5:checked ~ .vg-opanels > .vg-op5{display:block}
.vg-or5:checked ~ .vg-otablist > .vg-ot5,.vg-or5:checked ~ .vg-ohead > .vg-otablist > .vg-ot5{background:#24292F;border-color:#24292F;color:#fff}
.vg-or6:checked ~ .vg-opanels > .vg-op6{display:block}
.vg-or6:checked ~ .vg-otablist > .vg-ot6,.vg-or6:checked ~ .vg-ohead > .vg-otablist > .vg-ot6{background:#24292F;border-color:#24292F;color:#fff}
.vg-or7:checked ~ .vg-opanels > .vg-op7{display:block}
.vg-or7:checked ~ .vg-otablist > .vg-ot7,.vg-or7:checked ~ .vg-ohead > .vg-otablist > .vg-ot7{background:#24292F;border-color:#24292F;color:#fff}
.vg-or8:checked ~ .vg-opanels > .vg-op8{display:block}
.vg-or8:checked ~ .vg-otablist > .vg-ot8,.vg-or8:checked ~ .vg-ohead > .vg-otablist > .vg-ot8{background:#24292F;border-color:#24292F;color:#fff}
.vg-br1:checked ~ .vg-bpanels > .vg-bp1{display:block}
.vg-br1:checked ~ .vg-btablist > .vg-bt1{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br2:checked ~ .vg-bpanels > .vg-bp2{display:block}
.vg-br2:checked ~ .vg-btablist > .vg-bt2{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br3:checked ~ .vg-bpanels > .vg-bp3{display:block}
.vg-br3:checked ~ .vg-btablist > .vg-bt3{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br4:checked ~ .vg-bpanels > .vg-bp4{display:block}
.vg-br4:checked ~ .vg-btablist > .vg-bt4{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br5:checked ~ .vg-bpanels > .vg-bp5{display:block}
.vg-br5:checked ~ .vg-btablist > .vg-bt5{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br6:checked ~ .vg-bpanels > .vg-bp6{display:block}
.vg-br6:checked ~ .vg-btablist > .vg-bt6{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br7:checked ~ .vg-bpanels > .vg-bp7{display:block}
.vg-br7:checked ~ .vg-btablist > .vg-bt7{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br8:checked ~ .vg-bpanels > .vg-bp8{display:block}
.vg-br8:checked ~ .vg-btablist > .vg-bt8{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br9:checked ~ .vg-bpanels > .vg-bp9{display:block}
.vg-br9:checked ~ .vg-btablist > .vg-bt9{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br10:checked ~ .vg-bpanels > .vg-bp10{display:block}
.vg-br10:checked ~ .vg-btablist > .vg-bt10{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br11:checked ~ .vg-bpanels > .vg-bp11{display:block}
.vg-br11:checked ~ .vg-btablist > .vg-bt11{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-br12:checked ~ .vg-bpanels > .vg-bp12{display:block}
.vg-br12:checked ~ .vg-btablist > .vg-bt12{background:#fbeded;border-color:#efb6b6;color:#24292F}
.vg-r1:checked ~ .vg-panels > .vg-p1{display:block}
.vg-r1:checked ~ .vg-tablist > .vg-t1{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r1:checked ~ .vg-tablist > .vg-t1 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r2:checked ~ .vg-panels > .vg-p2{display:block}
.vg-r2:checked ~ .vg-tablist > .vg-t2{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r2:checked ~ .vg-tablist > .vg-t2 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r3:checked ~ .vg-panels > .vg-p3{display:block}
.vg-r3:checked ~ .vg-tablist > .vg-t3{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r3:checked ~ .vg-tablist > .vg-t3 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r4:checked ~ .vg-panels > .vg-p4{display:block}
.vg-r4:checked ~ .vg-tablist > .vg-t4{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r4:checked ~ .vg-tablist > .vg-t4 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r5:checked ~ .vg-panels > .vg-p5{display:block}
.vg-r5:checked ~ .vg-tablist > .vg-t5{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r5:checked ~ .vg-tablist > .vg-t5 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r6:checked ~ .vg-panels > .vg-p6{display:block}
.vg-r6:checked ~ .vg-tablist > .vg-t6{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r6:checked ~ .vg-tablist > .vg-t6 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r7:checked ~ .vg-panels > .vg-p7{display:block}
.vg-r7:checked ~ .vg-tablist > .vg-t7{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r7:checked ~ .vg-tablist > .vg-t7 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r8:checked ~ .vg-panels > .vg-p8{display:block}
.vg-r8:checked ~ .vg-tablist > .vg-t8{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r8:checked ~ .vg-tablist > .vg-t8 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r9:checked ~ .vg-panels > .vg-p9{display:block}
.vg-r9:checked ~ .vg-tablist > .vg-t9{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r9:checked ~ .vg-tablist > .vg-t9 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r10:checked ~ .vg-panels > .vg-p10{display:block}
.vg-r10:checked ~ .vg-tablist > .vg-t10{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r10:checked ~ .vg-tablist > .vg-t10 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r11:checked ~ .vg-panels > .vg-p11{display:block}
.vg-r11:checked ~ .vg-tablist > .vg-t11{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r11:checked ~ .vg-tablist > .vg-t11 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-r12:checked ~ .vg-panels > .vg-p12{display:block}
.vg-r12:checked ~ .vg-tablist > .vg-t12{background:#fff;border-color:#D0D7DE;color:#24292F}
.vg-r12:checked ~ .vg-tablist > .vg-t12 .vg-tabn{background:#DDF4FF;color:#0969DA}
.vg-md{font:13px/1.75 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F;overflow-wrap:anywhere}
.vg-mdempty{color:#8C959F}
.vg-md>:first-child{margin-top:0}
.vg-md>:last-child,.vg-mdq>:last-child{margin-bottom:0}
.vg-mdh1{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A;margin:18px 0 8px}
.vg-mdh2{font-weight:600;font-size:14px;line-height:1.6;color:#1A1A1A;margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid #EAEEF2}
.vg-mdh3{font-weight:600;font-size:13px;line-height:1.6;color:#24292F;margin:14px 0 6px}
.vg-mdh4,.vg-mdh5,.vg-mdh6{font-weight:600;font-size:12px;line-height:1.6;color:#57606A;margin:12px 0 6px}
.vg-mdp{margin:0 0 10px}
.vg-mdul,.vg-mdol{margin:0 0 10px;padding-left:22px}
.vg-mdli{margin:2px 0}
.vg-mdli>.vg-mdul,.vg-mdli>.vg-mdol{margin:2px 0 0}
.vg-mdtw{overflow-x:auto;margin:0 0 12px}
.vg-mdtable{border-collapse:collapse;font-size:12px}
.vg-mdth{border:1px solid #D0D7DE;padding:5px 10px;background:#F6F8FA;font-weight:600;text-align:left;white-space:nowrap}
.vg-mdtd{border:1px solid #D0D7DE;padding:5px 10px;vertical-align:top}
.vg-mdtl{text-align:left}
.vg-mdtc{text-align:center}
.vg-mdtr{text-align:right}
.vg-mdpre{margin:0 0 12px;padding:10px 12px;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA;overflow-x:auto}
.vg-mdpre code{font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;color:#24292F}
.vg-mdcode{padding:1px 5px;border-radius:3px;background:#EFF1F3;color:#24292F;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-mdq{margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid #D0D7DE;color:#57606A}
.vg-mdhr{margin:14px 0;border:none;border-top:1px solid #D0D7DE}
.vg-mda{color:#0969DA;text-decoration:none}
.vg-mda:hover{text-decoration:underline}
.vg-ctablewrap{width:100%}
.vg-ctable{border-collapse:collapse;font-size:12px;width:100%;max-width:1000px;table-layout:fixed}
.vg-chead{position:sticky;top:var(--vg-bar);z-index:1;padding:6px 12px;border:1px solid #D0D7DE;background:#F6F8FA;color:#24292F;font-weight:600;font-size:11px;text-align:left;overflow-wrap:anywhere}
.vg-cname{position:sticky;left:0;z-index:1;background:#fff;padding:5px 12px;border:1px solid #D0D7DE;text-align:left;box-shadow:1px 0 0 #D0D7DE;vertical-align:top;font-weight:600;font-size:12px;color:#24292F;overflow-wrap:anywhere;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-cnamehead{left:0;z-index:2;box-shadow:1px 0 0 #D0D7DE}
.vg-cdesc{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:400;color:#57606A}
.vg-cdtable{margin:3px 0 0;border-collapse:collapse;width:100%}
.vg-cdk{padding:1px 6px 1px 0;border-right:1px solid #EAEEF2;text-align:left;vertical-align:top;white-space:nowrap;font:10px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;color:#8C959F}
.vg-cdv{padding:1px 0 1px 6px;vertical-align:top;width:100%;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:400;color:#57606A;overflow-wrap:anywhere}
.vg-cdescwho{margin:4px 0 0;font:10px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:600;color:#8C959F}
.vg-cd1{padding-left:26px}
.vg-cd2{padding-left:40px}
.vg-cd3{padding-left:54px}
.vg-cnestmark{margin-right:4px;color:#8C959F;font-weight:400}
.vg-ccell{padding:5px 12px;border:1px solid #D0D7DE;vertical-align:top;color:#24292F;overflow-wrap:anywhere;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-cmeta{margin-left:6px;font:8px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;letter-spacing:.04em;color:#8C959F;white-space:nowrap}
.vg-cdiff{background:#dfe7d2}
.vg-cnone{color:#8C959F;background:#FAFAFA}
.vg-cmix{box-shadow:inset 0 0 0 2px #D4A72C}
.vg-cwarn{position:relative;margin-left:6px;color:#9A6700;cursor:help}
.vg-cwarn::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}
.vg-cwarn:hover::after{display:block}
.vg-sr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-stablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px}
.vg-slabel{color:#57606A;font-size:12px;font-weight:600;margin-right:2px}
.vg-stab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid #D0D7DE;border-radius:14px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-stab:hover{background:#EAEEF2;color:#24292F}
.vg-spanel{display:none}
.vg-sqlhead{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:7px 12px;border:1px solid #D0D7DE;border-bottom:none;border-radius:6px 6px 0 0;background:#F6F8FA}
.vg-sqlname{font-weight:600;font-size:12px;line-height:1.6;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-sqlmeta{color:#57606A;font-size:11px;line-height:1.6}
.vg-sqlbox{overflow-x:auto;border:1px solid #D0D7DE;border-radius:0 0 6px 6px;background:#fff}
.vg-sqlpre{margin:0;padding:8px 12px;white-space:pre;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#24292F}
.vg-sqln{color:#8C959F;user-select:none}
.vg-sr1:checked ~ .vg-spanels > .vg-sp1{display:block}
.vg-sr1:checked ~ .vg-stablist > .vg-st1{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr2:checked ~ .vg-spanels > .vg-sp2{display:block}
.vg-sr2:checked ~ .vg-stablist > .vg-st2{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr3:checked ~ .vg-spanels > .vg-sp3{display:block}
.vg-sr3:checked ~ .vg-stablist > .vg-st3{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr4:checked ~ .vg-spanels > .vg-sp4{display:block}
.vg-sr4:checked ~ .vg-stablist > .vg-st4{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr5:checked ~ .vg-spanels > .vg-sp5{display:block}
.vg-sr5:checked ~ .vg-stablist > .vg-st5{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr6:checked ~ .vg-spanels > .vg-sp6{display:block}
.vg-sr6:checked ~ .vg-stablist > .vg-st6{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr7:checked ~ .vg-spanels > .vg-sp7{display:block}
.vg-sr7:checked ~ .vg-stablist > .vg-st7{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr8:checked ~ .vg-spanels > .vg-sp8{display:block}
.vg-sr8:checked ~ .vg-stablist > .vg-st8{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr9:checked ~ .vg-spanels > .vg-sp9{display:block}
.vg-sr9:checked ~ .vg-stablist > .vg-st9{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr10:checked ~ .vg-spanels > .vg-sp10{display:block}
.vg-sr10:checked ~ .vg-stablist > .vg-st10{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr11:checked ~ .vg-spanels > .vg-sp11{display:block}
.vg-sr11:checked ~ .vg-stablist > .vg-st11{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr12:checked ~ .vg-spanels > .vg-sp12{display:block}
.vg-sr12:checked ~ .vg-stablist > .vg-st12{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr13:checked ~ .vg-spanels > .vg-sp13{display:block}
.vg-sr13:checked ~ .vg-stablist > .vg-st13{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr14:checked ~ .vg-spanels > .vg-sp14{display:block}
.vg-sr14:checked ~ .vg-stablist > .vg-st14{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr15:checked ~ .vg-spanels > .vg-sp15{display:block}
.vg-sr15:checked ~ .vg-stablist > .vg-st15{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr16:checked ~ .vg-spanels > .vg-sp16{display:block}
.vg-sr16:checked ~ .vg-stablist > .vg-st16{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr17:checked ~ .vg-spanels > .vg-sp17{display:block}
.vg-sr17:checked ~ .vg-stablist > .vg-st17{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr18:checked ~ .vg-spanels > .vg-sp18{display:block}
.vg-sr18:checked ~ .vg-stablist > .vg-st18{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr19:checked ~ .vg-spanels > .vg-sp19{display:block}
.vg-sr19:checked ~ .vg-stablist > .vg-st19{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr20:checked ~ .vg-spanels > .vg-sp20{display:block}
.vg-sr20:checked ~ .vg-stablist > .vg-st20{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr21:checked ~ .vg-spanels > .vg-sp21{display:block}
.vg-sr21:checked ~ .vg-stablist > .vg-st21{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr22:checked ~ .vg-spanels > .vg-sp22{display:block}
.vg-sr22:checked ~ .vg-stablist > .vg-st22{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr23:checked ~ .vg-spanels > .vg-sp23{display:block}
.vg-sr23:checked ~ .vg-stablist > .vg-st23{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-sr24:checked ~ .vg-spanels > .vg-sp24{display:block}
.vg-sr24:checked ~ .vg-stablist > .vg-st24{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-nsec{margin:0 0 18px}
.vg-nsec:last-child{margin-bottom:0}
.vg-nhead{margin:0 0 6px;padding:0 0 4px;border-bottom:1px solid #EAEEF2;font:11px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:600;letter-spacing:.04em;color:#57606A}
.vg-dr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-dtablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}
.vg-dtab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid #D0D7DE;border-radius:14px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-dtab:hover{background:#F6F8FA;color:#24292F}
.vg-dpanel{display:none}
.vg-dtab.vg-dstatic{background:#EAEEF2;border-color:#8C959F;color:#24292F;cursor:default}
.vg-dr1:checked ~ .vg-dpanels > .vg-dp1{display:block}
.vg-dr1:checked ~ .vg-dtablist > .vg-dt1{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr2:checked ~ .vg-dpanels > .vg-dp2{display:block}
.vg-dr2:checked ~ .vg-dtablist > .vg-dt2{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr3:checked ~ .vg-dpanels > .vg-dp3{display:block}
.vg-dr3:checked ~ .vg-dtablist > .vg-dt3{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr4:checked ~ .vg-dpanels > .vg-dp4{display:block}
.vg-dr4:checked ~ .vg-dtablist > .vg-dt4{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr5:checked ~ .vg-dpanels > .vg-dp5{display:block}
.vg-dr5:checked ~ .vg-dtablist > .vg-dt5{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr6:checked ~ .vg-dpanels > .vg-dp6{display:block}
.vg-dr6:checked ~ .vg-dtablist > .vg-dt6{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr7:checked ~ .vg-dpanels > .vg-dp7{display:block}
.vg-dr7:checked ~ .vg-dtablist > .vg-dt7{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr8:checked ~ .vg-dpanels > .vg-dp8{display:block}
.vg-dr8:checked ~ .vg-dtablist > .vg-dt8{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr9:checked ~ .vg-dpanels > .vg-dp9{display:block}
.vg-dr9:checked ~ .vg-dtablist > .vg-dt9{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr10:checked ~ .vg-dpanels > .vg-dp10{display:block}
.vg-dr10:checked ~ .vg-dtablist > .vg-dt10{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr11:checked ~ .vg-dpanels > .vg-dp11{display:block}
.vg-dr11:checked ~ .vg-dtablist > .vg-dt11{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr12:checked ~ .vg-dpanels > .vg-dp12{display:block}
.vg-dr12:checked ~ .vg-dtablist > .vg-dt12{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr13:checked ~ .vg-dpanels > .vg-dp13{display:block}
.vg-dr13:checked ~ .vg-dtablist > .vg-dt13{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr14:checked ~ .vg-dpanels > .vg-dp14{display:block}
.vg-dr14:checked ~ .vg-dtablist > .vg-dt14{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr15:checked ~ .vg-dpanels > .vg-dp15{display:block}
.vg-dr15:checked ~ .vg-dtablist > .vg-dt15{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-dr16:checked ~ .vg-dpanels > .vg-dp16{display:block}
.vg-dr16:checked ~ .vg-dtablist > .vg-dt16{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.d13bjngc{padding:0 4px;background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);}
.d13c6wgv{padding:0 4px;text-align:center;color:#6a7d4b;}
.d199it5c{color:#874a4a;font-weight:400;}
.d19psjdt{color:#1A7F37;background:#DAFBE1}
.d1cqaqta{background:#efb6b6;border-radius:2px;}
.d1gyu01d{border-collapse:collapse;border:1px solid #E0E0E0;border-radius:4px;overflow:visible;font-size:12px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18);-webkit-text-size-adjust:100%;text-size-adjust:100%;}
.d1ha5k0q{padding:0 4px;text-align:center;color:#a25959;}
.d1hduafk{color:#098658;}
.d1imcu2c{color:#CF222E;}
.d1r87v19{padding:0 12px;white-space:pre-wrap;border-left:1px solid #E0E0E0;background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);}
.d1rgbq4v{padding:0 10px;border-right:1px solid #ECEFF1;border-left:1px solid #E0E0E0;background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);}
.d1s1c2xa{color:#57606A;background:#EAEEF2}
.d1xrfuoj{width:40px}
.d1xthima{padding:0 10px;text-align:right;color:#B0BAC5;background:#fef8f8;border-right:1px solid #ECEFF1;white-space:nowrap;}
.d2gmdtm{padding:0 10px;text-align:right;color:#B0BAC5;background:#fafbf7;border-right:1px solid #ECEFF1;border-left:1px solid #E0E0E0;white-space:nowrap;}
.ddcvljg{text-align:left;font-family:'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;font-weight:600;color:#1A1A1A;background:#fbeded;border-bottom:2px solid #E17B7B;padding:7px 12px;}
.dee9yni{padding:0 10px;border-right:1px solid #ECEFF1;background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);}
.deev4tz{font-family:'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;color:#24292F;line-height:1.35;-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;}
.defi7oa{color:#9A6700;background:#FFF8C5}
.dg299g6{padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:#24292F;}
.dh8ndk{background:#c4d2ac;border-radius:2px;}
.dh8u7zg{padding:0 12px;white-space:pre-wrap;background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);}
.dn9u3nl{padding:0 4px;text-align:center;color:#90A4AE;}
.dokucl1{padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:#24292F;background:#dfe7d2;border-left:2px solid #93AE68;}
.dqwmvn2{color:#58683e;font-weight:400;}
.drap2zl{text-align:left;font-family:'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;font-weight:600;color:#1A1A1A;background:#f0f4ea;border-bottom:2px solid #93AE68;border-left:1px solid #E0E0E0;padding:7px 12px;}
.ds01o67{width:22px}
.duywfcf{padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:#24292F;background:#f6d7d7;border-left:2px solid #E17B7B;}
""";

-- 実行中のプロジェクトを INFORMATION_SCHEMA.SCHEMATA から自動検出する
-- （catalog_name = ジョブが動いているプロジェクト）。リージョン修飾の
-- 識別子はパラメータにできないので @@location から組み立てる。
EXECUTE IMMEDIATE FORMAT(
  "SELECT DISTINCT catalog_name FROM `region-%s`.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
  @@location
) INTO default_project_id;
ASSERT default_project_id IS NOT NULL AS
  'プロジェクト ID を自動検出できません（このリージョンにデータセットが無い？）。udf_project_id にリテラルを入れて固定してください。';
SET udf_project_id = COALESCE(udf_project_id, default_project_id);

-- 名前を組み立てる前に '{project_token}' を置き換える。
SET project_token =
  COALESCE(REGEXP_EXTRACT(default_project_id, project_token_pattern), '');
SET udf_dataset     = REPLACE(udf_dataset,     '{project_token}', project_token);
SET udf_name_prefix = REPLACE(udf_name_prefix, '{project_token}', project_token);
SET udf_name_suffix = REPLACE(udf_name_suffix, '{project_token}', project_token);

ASSERT REGEXP_CONTAINS(udf_dataset, r'^[A-Za-z0-9_]+$') AS
  'udf_dataset は英数字と _ だけにしてください（置換されていない {project_token} が残っていませんか）。';

-- 関数名: udf_name_prefix + system_name + '_' + 基本名 + udf_name_suffix
ASSERT REGEXP_CONTAINS(system_name, r'^[A-Za-z0-9_]+$') AS
  'system_name は英数字と _ だけにしてください（ルーチン名に - は使えません）。';
SET udf_analyze_function_name =
  udf_name_prefix || system_name || '_' || 'analyze' || udf_name_suffix;
SET udf_render_function_name =
  udf_name_prefix || system_name || '_' || 'render' || udf_name_suffix;
SET udf_css_function_name =
  udf_name_prefix || system_name || '_' || 'group_css' || udf_name_suffix;
SET udf_erd_function_name =
  udf_name_prefix || system_name || '_' || 'erd' || udf_name_suffix;
SET udf_page_function_name =
  udf_name_prefix || system_name || '_' || 'page' || udf_name_suffix;
SET udf_markdown_function_name =
  udf_name_prefix || system_name || '_' || 'markdown' || udf_name_suffix;
SET udf_sql_function_name =
  udf_name_prefix || system_name || '_' || 'render_dynamic_sql' || udf_name_suffix;
ASSERT REGEXP_CONTAINS(udf_analyze_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_analyze_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_render_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_erd_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_erd_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_page_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_page_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_markdown_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_markdown_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_sql_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_sql_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';


-- ---------------------------------------------------------------------
-- 1. viewlgc_analyze
--    base 1 件分の View 群を渡すと、解析結果を JSON で返す
--
-- 解析と描画を別の UDF に分けてある。インラインのコード ブロブは 1 個あたり
-- 32 KB までなので、1 本にまとめると枠が 1 つしか使えない。JS UDF の中から
-- 別の UDF は呼べないため、つなぐのは呼び出し側の SQL の仕事
-- （build_table.sql は analyze を 1 回呼び、その結果を render に渡す）。
--
-- 引数:
--   views         ARRAY<STRUCT<view_name STRING, ddl STRING>>
--                 同じ base を持つ View を全部渡す
--   options_json  NULL または '{}' で既定
--
-- 戻り値 STRING（JSON）:
--   viewCount      渡された View 数
--   groupCount     ロジックのグループ数（1 なら全部同一＝正常）
--   groupLabels    ["abjp, abuk, abus", …] タブ / ペイン見出し
--   groupSizes     各グループの View 数
--   suffixes       認識した suffix 一覧
--   unmatchedCount suffix を認識できなかった数
--   bases          描画に渡す本体。lead / tail は案内文
--   （メタデータは SQL 側で JSON_VALUE / JSON_VALUE_ARRAY で取り出す）
--
-- options_json のキー:
--   suffixParts   [["ab","cd","ef"],["jp","us","uk"]] のような区分の並び
--   suffixList    既知の suffix 一覧
--   suffixPattern 正規表現（既定は末尾の _ + 1〜6 文字）
--   substitutable 同一ロジックとみなす際に置換を許すトークン種別。
--                 既定 ["entity","number","string"]。置換してよいのは
--                 FROM / JOIN が指す実体名（entity）と値（number / string）
--                 だけ、という方針。列名・別名・CTE 名・ウィンドウ名・
--                 関数名は SQL の中で閉じた名前なので完全一致を要求する
--                 （横展開はコピーで行う運用なので、違えば書き換えの差）。
--                 値の差もロジック差として残したいなら ["entity"] にする。
--                 バッククォートの有無やパスの部分数は正規化しないので、
--                 意味が同じでも書き方が違えば別グループになる
--   suffixAware   比較の前に自分の suffix を伏せ字にする（既定 true）。
--                 リテラルに入った suffix でグループが割れるのを防ぐ
--   equivalentLiterals 同じグループとみなす文字列の組を 1 本の配列で並べる。
--                 ["suffix", ["aa","bb"], ["cc","dd"]]
--                 "suffix" は予約語で、その View 自身の suffix とその区分
--                 （abjp なら abjp / ab / jp）を表す。View ごとに中身が変わる
--                 ので値を並べて書けない。ほかの組は View に関係なく効く。
--                 1 つの配列が 1 つの同値類で、別の配列どうしは同一視しない
--                 （'aa' と 'cc' は別のまま）。照合は値の全体が一致したとき
--                 だけで、'x_aa_y' の aa は巻き込まない。大文字小文字は無視。
--                 文字列リテラルと数値リテラルが対象。
--   literalSuffixWords / literalGroups
--                 equivalentLiterals を書く前の旧い書き方。前者が "suffix"、
--                 後者が組の並びに当たる。equivalentLiterals を書くと
--                 そちらが一覧の唯一の定義になり、この 2 つは見ない
--   includeUnmatched suffix を認識できなかった View を単独の base として
--                 表示する（既定 true）。false で従来どおり除外
--   stripOptions  OPTIONS( … ) 句を落としてから比較する（既定 true）
--   layout        'auto'（既定・3 グループ以上はタブ）/ 'panes' / 'tabs'
--   mode          'inline'（既定）/ 'class'（CSS は group_css へ）/ 'embed'
--   fontSize / lineHeight / colors / diffLineOpacity / diffCharOpacity / syntax
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  views ARRAY<STRUCT<view_name STRING, ddl STRING>>,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_analyze_function_name,
  TO_JSON_STRING(js_analyze));


-- ---------------------------------------------------------------------
-- 2. viewlgc_render
--    viewlgc_analyze が返した JSON を受け取って比較 HTML にする
--
-- 解析はしない。options_json は analyze に渡したものと同じものを渡すこと
-- （mode / layout / 色の指定はこちらで効く）。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  analysis_json STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_render_function_name,
  TO_JSON_STRING(js_render));


-- ---------------------------------------------------------------------
-- 3. viewlgc_erd
--    参照関係の図を作る
--
-- 図だけを返す。束ねるのは viewlgc_page の仕事。
--
-- **カラム定義・SQL・外枠とは別の UDF にしてある。** 図を描くには SQL の
-- トークナイザ（analyze.js）が要り、それだけで最小化後 9 KB ある。同居させて
-- いた頃は 1 本で 28 KB（インライン上限 32 KB に対して 92%）まで来ていて、
-- カラム定義に手を入れるたびに枠を気にすることになっていた。依存が独立して
-- いる場所で割ってある。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  analysis_json STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_erd_function_name,
  TO_JSON_STRING(js_erd));


-- ---------------------------------------------------------------------
-- 4. viewlgc_page
--    カラム定義の表と View ごとの素の SQL を作り、渡された差分 HTML・
--    参照関係の図と合わせて外側タブで束ねて 1 枚にする
--
-- タブは左から note / カラム定義 / 参照関係 / ロジック差分 / SQL で、
-- 既定で開くのは note。
-- カラム定義は columns_json（INFORMATION_SCHEMA.COLUMNS を base ごとにまとめた
-- もの）から作る。取れなくても落とさず、そのタブだけ案内にする。
-- SQL タブは sql_json（INFORMATION_SCHEMA.VIEWS.view_definition を base ごとに
-- まとめたもの）から作る。パラメータ化していない素のテキストで、インナーの
-- タブは グループではなく View（suffix）単位。
-- 差分も図も作らない。viewlgc_render / viewlgc_erd の出力をそのまま受け取る。
--
-- note タブは二段構え。上段が View 自身の description で、descs_json
-- （[{v: [View 名...], h: HTML}]）から作る。**Markdown を HTML にするのは
-- 呼び出し側の SQL（viewlgc_markdown）。** JS UDF から別の UDF は呼べない。
-- 文面が割れている base ではタブになり、1 種類ならタブは出ない。
--
-- 下段のメモの中身はここでは入れない。パネルには目印 '<!--VG_NOTE-->' だけを
-- 置き、ビューが REPLACE で note_html に差し替える。ここで焼き込むと、シートを
-- 直しても次の日次実行までレポートが古いままになる。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  analysis_json STRING,
  diff_html STRING,
  erd_html STRING,
  columns_json STRING,
  sql_json STRING,
  descs_json STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_page_function_name,
  TO_JSON_STRING(js_page));


-- ---------------------------------------------------------------------
-- 5. viewlgc_markdown
--    base ごとのメモ（Markdown）を HTML にする
--
-- これだけはビューの中から呼ぶ（＝レポートを開くたびに走る）。事前生成の
-- テーブルに焼き込むと、メモを直しても次の日次実行まで古いままになるため。
-- Markdown は 1 件が数 KB なので、クエリのたびに変換しても実行時間に響かない。
--
-- 生の HTML は通さない（必ずエスケープする）。画像も読み込まない。
-- 出す markup のクラスは viewlgc_group_css の CSS と 1 対 1 で対応する。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(md STRING)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_markdown_function_name,
  TO_JSON_STRING(js_markdown));


-- ---------------------------------------------------------------------
-- 6. viewlgc_group_css
--    mode='class' のときテンプレートへ貼る CSS を返す
--
--   SELECT `<project>.<udf_dataset>.viewlgc_group_css`(NULL);
--
-- 結果を <style> … </style> で囲んで Templated Record のテンプレートに貼る。
-- 見出し・タブ・パラメータ表の規則と、差分表の規則の両方を含む。
-- タブの CSS は ID ではなくクラスで書いてあるので、レコードが変わっても
-- この CSS のまま使える。
--
-- **JavaScript ではなく SQL の関数で、固定の文字列を返すだけ。**
-- 以前は描画コード一式を積んで実行時に組み立てていたが、それだと CSS を
-- 足すたびにインラインの 32 KB 枠に近づき、実際に上限へ当たった。CSS の
-- 中身は生成時に決まっていて実行時に変わる要素が無いので、build_udf.mjs が
-- 組み立てた結果をそのまま焼き込む。組み立てには実物の描画コードを通して
-- いるので、markup とクラス名が食い違わない点は変わらない
-- （生成時のクラス網羅チェックが見張る）。
--
-- options_json は受け取るが見ない。色やフォントを変えたときは
-- node build_udf.mjs で作り直し、この SQL ごと流し直すこと。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(options_json STRING)
RETURNS STRING
AS (%s)
''',
  udf_project_id, udf_dataset, udf_css_function_name,
  TO_JSON_STRING(css_text));


-- ---------------------------------------------------------------------
-- 7. viewlgc_render_dynamic_sql
--    build_table.sql の SQL テンプレートに含まれる __…__ を展開する
--
-- BigQuery は識別子（プロジェクト・データセット・テーブル・関数名）を
-- クエリ パラメータにできない。@param が使えるのは値だけ。そこで
-- テンプレートの目印をこの関数で置き換えてから EXECUTE IMMEDIATE する。
--
-- 永続関数にしてあるのは、スクリプトの TEMP FUNCTION を 1 つでも置くと
-- その DDL が子ジョブすべてのクエリ本文に前置され、コンソールの結果一覧が
-- どれも TEMP FUNCTION の DDL に見えてしまうため（CREATE VIEW も通らない）。
--
-- 置き換える目印:
--   __TARGET_PROJECT__     読み取り対象のプロジェクト
--   __JOB_REGION__         region- を除いたロケーション
--   __T_DIFF_SRC__         生成した素のカードのテーブル（project.dataset.table）
--   __T_DIFF__             メモを差し込み済みのテーブル。レポートはこれを読む
--   __T_BASE_NOTE__        base ごとのメモの外部テーブル（同上）
--   __V_DIFF__             メモを差し込むビュー。レポートはこれを読む
--   __UDF_ANALYZE__        analyze 関数（project.dataset.function）
--   __UDF_RENDER__         render 関数（同上）
--   __UDF_ERD__            参照関係の図を作る関数（同上）
--   __UDF_PAGE__           page 関数（同上）
--   __UDF_MARKDOWN__       markdown 関数（同上）
--   __UDF_CSS__            group_css 関数（同上）
--   __TZ__                 snapshot_date（生成日）の基準タイムゾーン
--   __SUFFIX_PATTERN__     suffix を切り出す正規表現
--   __NOTE_SHEET_URL__     メモのスプレッドシートの URL
--   __NOTE_SHEET_RANGE__   その中の読み取り範囲
--   __SCHEMA_COND__        SCHEMATA 用の絞り込み条件（SQL 片）
--   __VIEW_DATASET_COND__  VIEWS 用のデータセット条件（SQL 片）
--   __VIEW_NAME_COND__     VIEWS 用の View 名条件（SQL 片）
--
-- 中身が SQL になるもの（__*_COND__）を最後に置くのは、置き換えた中身が
-- さらに走査されないようにするため。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  sql_template STRING,
  work_project_id STRING,
  work_dataset STRING,
  udf_project_id STRING,
  udf_dataset STRING,
  target_project_id STRING,
  job_region STRING,
  objects STRUCT<
    diff_src          STRING,
    diff_table        STRING,
    diff_view         STRING,
    base_note         STRING,
    analyze_function  STRING,
    render_function   STRING,
    erd_function      STRING,
    page_function     STRING,
    markdown_function STRING,
    css_function      STRING
  >,
  options STRUCT<
    time_zone        STRING,
    suffix_pattern   STRING,
    note_sheet_url   STRING,
    note_sheet_range STRING
  >,
  conditions STRUCT<
    schema_condition       STRING,
    view_dataset_condition STRING,
    view_name_condition    STRING
  >
)
RETURNS STRING
AS (
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
  REPLACE(
    sql_template,
    '__TARGET_PROJECT__', target_project_id),
    '__JOB_REGION__', job_region),
    '__T_DIFF_SRC__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_src),
    '__T_DIFF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_table),
    '__T_BASE_NOTE__',
      work_project_id || '.' || work_dataset || '.' || objects.base_note),
    '__V_DIFF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_view),
    '__UDF_ANALYZE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.analyze_function),
    '__UDF_RENDER__',
      udf_project_id || '.' || udf_dataset || '.' || objects.render_function),
    '__UDF_ERD__',
      udf_project_id || '.' || udf_dataset || '.' || objects.erd_function),
    '__UDF_PAGE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.page_function),
    '__UDF_MARKDOWN__',
      udf_project_id || '.' || udf_dataset || '.' || objects.markdown_function),
    '__UDF_CSS__',
      udf_project_id || '.' || udf_dataset || '.' || objects.css_function),
    '__TZ__', options.time_zone),
    '__SUFFIX_PATTERN__', options.suffix_pattern),
    '__NOTE_SHEET_URL__', options.note_sheet_url),
    '__NOTE_SHEET_RANGE__', options.note_sheet_range),
    '__SCHEMA_COND__', conditions.schema_condition),
    '__VIEW_DATASET_COND__', conditions.view_dataset_condition),
    '__VIEW_NAME_COND__', conditions.view_name_condition)
)
''',
  udf_project_id, udf_dataset, udf_sql_function_name);


-- 作った 7 つの名前を出す。build_table.sql に同じ値を入れる。
SELECT
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_analyze_function_name)  AS analyze_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_render_function_name)   AS render_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_erd_function_name)      AS erd_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_page_function_name)     AS page_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_markdown_function_name) AS markdown_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_css_function_name)      AS css_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_sql_function_name)      AS sql_function,
  CURRENT_TIMESTAMP() AS created_at;
END;
