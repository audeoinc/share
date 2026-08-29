-- =====================================================================
-- suffix 違い View のロジック グループ比較の UDF を作る
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    再生成: node looker_studio/view_groups/build_udf.mjs
--    本体は esbuild で最小化してある（インラインのコード ブロブは
--    32 KB までに制限されるため。素の連結は約 48 KB で確実に弾かれる）。
--
-- 作る関数は 6 つ。名前はすべて CONFIGURATION の値から組み立てる。
--   viewlgc_analyze             View 群を解析して JSON を返す（JavaScript）
--   viewlgc_render              その JSON を比較 HTML にする（JavaScript）
--   viewlgc_page                参照関係の図を作り、差分と外側タブで束ねる（JavaScript）
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
--     先頭に入る（既定なら viewlgc_analyze / viewlgc_t_diff_hist）。
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
var E=Object.defineProperty,k=Object.defineProperties;var A=Object.getOwnPropertyDescriptors;var g=Object.getOwnPropertySymbols;var T=Object.prototype.hasOwnProperty,C=Object.prototype.propertyIsEnumerable;var x=(e,t,n)=>t in e?E(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,m=(e,t)=>{for(var n in t||(t={}))T.call(t,n)&&x(e,n,t[n]);if(g)for(var n of g(t))C.call(t,n)&&x(e,n,t[n]);return e},S=(e,t)=>k(e,A(t));const DQ="\\u0022",DQ3=DQ+DQ+DQ,TOKEN_RE=new RegExp(["(`[^`]*`)","([rbRB]{1,2}(?:'''[\\s\\S]*?'''|"+DQ3+"[\\s\\S]*?"+DQ3+"|'[^']*'|"+DQ+"[^"+DQ+"]*"+DQ+"))","('''[\\s\\S]*?''')","("+DQ3+"[\\s\\S]*?"+DQ3+")","('(?:\\\\.|''|[^'\\\\])*')","("+DQ+"(?:\\\\.|"+DQ+DQ+"|[^"+DQ+"\\\\])*"+DQ+")","(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(0[xX][0-9a-fA-F]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],n=String(e==null?"":e);let o;for(TOKEN_RE.lastIndex=0;(o=TOKEN_RE.exec(n))!==null;){let i;o[1]?i="quoted":o[2]||o[3]||o[4]||o[5]||o[6]?i="string":o[7]||o[8]?i="comment":o[9]?i="number":o[10]?i=KEYWORDS.has(o[10].toUpperCase())?"keyword":"ident":o[11]?i="space":i="punct",t.push({kind:i,text:o[0]})}return t}function stripOptionsClause(e){const t=[];let n=0;for(;n<e.length;){const o=e[n];if(o.kind==="keyword"&&o.text.toUpperCase()==="OPTIONS"){let i=n+1;for(;i<e.length&&e[i].kind==="space";)i++;if(i<e.length&&e[i].text==="("){let u=0,r=i;for(;r<e.length;r++)if(e[r].text==="(")u++;else if(e[r].text===")"&&(u--,u===0)){r++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();n=r;continue}}t.push(o),n++}return t}function markEntities(e){const t=e.slice(),n=u=>{let r=u+1;for(;r<t.length&&t[r].kind==="space";)r++;return r},o=[];let i=null;for(let u=0;u<t.length;u++){const r=t[u];if(r.kind==="space"||r.kind==="comment")continue;if(r.text==="("){o.push(i),i=null;continue}if(r.text===")"){o.pop(),i=null;continue}const s=r.text.toUpperCase();if(i=r.kind==="keyword"||r.kind==="ident"?s:null,r.kind!=="keyword"||s!=="FROM"&&s!=="JOIN"||o.length>0&&o[o.length-1]==="EXTRACT")continue;let f=n(u);for(;!(f>=t.length);){const l=t[f];if(l.kind==="quoted")t[f]={kind:"entity",text:l.text},f=n(f);else if(l.kind==="ident"){const a=[];let c=f;for(;;){a.push(c);const p=n(c);if(p<t.length&&t[p].text==="."){const d=n(p);if(d<t.length&&t[d].kind==="ident"){c=d;continue}}break}const h=n(c);if(h<t.length&&t[h].text==="(")break;for(const p of a)t[p]={kind:"entity",text:t[p].text};f=h}else break;if(f<t.length&&t[f].kind==="keyword"&&t[f].text.toUpperCase()==="AS"){const a=n(f);a<t.length&&(t[a].kind==="ident"||t[a].kind==="quoted")&&(f=n(a))}else f<t.length&&t[f].kind==="ident"&&(f=n(f));if(f<t.length&&t[f].text===","){f=n(f);continue}break}}return t}function normalizeSpace(e){return e.map(t=>t.kind==="space"?{kind:"space",text:" "}:t)}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/;function expandSuffixParts(e){let t=[""];for(const n of e){const o=[];for(const i of t)for(const u of n)o.push(i+u);t=o}return t.sort((n,o)=>o.length-n.length||n.localeCompare(o))}function extractSuffix(e,t){const n=t||{};if(Array.isArray(n.suffixParts)&&n.suffixParts.length>0){const u=n._expanded||(n._expanded=expandSuffixParts(n.suffixParts));for(const r of u)if(e.length>r.length+1&&e.endsWith("_"+r)){const s=[];let f=r;for(const l of n.suffixParts){const a=l.find(c=>f.startsWith(c));if(a===void 0){s.length=0;break}s.push(a),f=f.slice(a.length)}return{base:e.slice(0,-(r.length+1)),suffix:r,parts:s.length?s:void 0}}return null}if(Array.isArray(n.suffixList)&&n.suffixList.length>0){for(const u of n.suffixList)if(e.length>u.length+1&&e.endsWith("_"+u))return{base:e.slice(0,-(u.length+1)),suffix:u};return null}const o=n.suffixPattern?new RegExp(n.suffixPattern):DEFAULT_SUFFIX_RE,i=String(e).match(o);return i?{base:i[1],suffix:i[2]}:null}const DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001";function suffixWords(e,t){const n=String(e||"");if(n.length<2)return[];const o=[n];if(Array.isArray(t)&&t.length>0)for(const r of t)String(r).length>=2&&o.push(String(r));else n.length%2===0&&o.push(n.slice(0,n.length/2),n.slice(n.length/2));const i={},u=[];for(const r of o){const s=r.toLowerCase();i[s]||(i[s]=1,u.push(s))}return u}function buildLiteralMap(e){if(!Array.isArray(e)||e.length===0)return null;const t=typeof e[0]=="string"?[e]:e,n={};let o=0;for(let i=0;i<t.length;i++){if(!Array.isArray(t[i]))continue;const u=LITERAL_MARK+(i+1)+LITERAL_MARK;for(const r of t[i]){const s=String(r==null?"":r).toLowerCase();s&&(n[s]=u,o++)}}return o>0?n:null}function parseEquivalents(e){const t=e||{},n=t.equivalentLiterals;if(Array.isArray(n)){let o=!1;const i=[],u=[];for(const r of n)Array.isArray(r)?i.push(r):String(r).toLowerCase()==="suffix"?o=!0:r!=null&&u.push(r);return i.length===0&&u.length>0&&i.push(u),{useWords:o,groups:i.length>0?i:null}}return{useWords:t.literalSuffixWords!==!1,groups:Array.isArray(t.literalGroups)?t.literalGroups:null}}function maskTokens(e,t,n,o){const i=String(t||""),u=i.length>=2,r=parseEquivalents(o),s=u&&r.useWords?suffixWords(i,n):[],f=buildLiteralMap(r.groups);return!u&&s.length===0&&!f?e:e.map(l=>{if(l.kind==="space")return l;let a=l.text;if(u&&a.indexOf(i)>=0&&(a=a.split(i).join(SUFFIX_MARK)),s.length>0||f){const c=l.kind==="string"&&a.length>=2?a.slice(1,-1):l.kind==="number"?a:null;if(c){const h=c.toLowerCase(),p=s.indexOf(h)>=0?SUFFIX_MARK:f&&f[h];p&&(a=l.kind==="string"?a[0]+p+a[0]:p)}}return a===l.text?l:{kind:l.kind,text:a}})}function alphaMapDetail(e,t,n){if(e.length!==t.length)return{ok:!1,reason:"length",aLen:e.length,bLen:t.length};const o=new Set(n&&n.substitutable||DEFAULT_SUBSTITUTABLE),i=new Map,u=new Map;for(let r=0;r<e.length;r++){const s=e[r],f=t[r],l=a=>({ok:!1,reason:a,index:r,kind:s.kind,otherKind:f.kind,aText:s.text,bText:f.text});if(s.kind!==f.kind)return l("kind");if(s.text!==f.text){if(!o.has(s.kind))return l("not-substitutable");if(i.has(s.text)&&i.get(s.text)!==f.text)return l("inconsistent");if(u.has(f.text)&&u.get(f.text)!==s.text)return l("not-injective");i.set(s.text,f.text),u.set(f.text,s.text)}}return{ok:!0,fwd:i,rev:u}}function parameterize(e){const t=e[0].tokens.length,n=new Map,o=[],i=[];for(let u=0;u<t;u++){if(e[0].tokens[u].kind==="space"){i.push(e[0].raw[u].text);continue}const r=e.map(l=>l.raw[u].text);let s=!0;for(let l=1;l<r.length;l++)if(r[l]!==r[0]){s=!1;break}if(s){i.push(r[0]);continue}const f=JSON.stringify(r);if(!n.has(f)){const l="P"+(o.length+1);n.set(f,l);const a={};e.forEach((c,h)=>{a[c.suffix]=r[h]}),o.push({name:l,kind:e[0].raw[u].kind,values:a})}i.push("{{"+n.get(f)+"}}")}return{sql:i.join(""),params:o}}function groupByLogic(e,t){const n=!(t&&t.stripOptions===!1),o=!(t&&t.suffixAware===!1),i=e.map(s=>{let f=tokenizeSql(s.ddl);n&&(f=stripOptionsClause(f)),f=markEntities(f);const l=normalizeSpace(f);return S(m({},s),{raw:f,tokens:maskTokens(l,o?s.suffix:null,s.parts,t)})}),u=[];for(const s of i){let f=null;for(const l of u)if(alphaMapDetail(l.members[0].tokens,s.tokens,t).ok){f=l;break}f?f.members.push(s):u.push({members:[s]})}u.sort((s,f)=>f.members.length-s.members.length||String(s.members[0].suffix).localeCompare(String(f.members[0].suffix)));const r=u.map(s=>s.members[0]);return u.map((s,f)=>{const l=s.members.slice().sort((h,p)=>String(h.suffix).localeCompare(String(p.suffix))),a=parameterize(l),c=r.map((h,p)=>p===f?null:{vs:h.suffix,detail:alphaMapDetail(h.tokens,s.members[0].tokens,t)});return{suffixes:l.map(h=>h.suffix),members:l,sql:a.sql,params:a.params,missBy:c,miss:c[0]}})}function analyze(e,t){const n=!(t&&t.includeUnmatched===!1),o=new Map,i=[];for(const r of e){const s=extractSuffix(r.view_name,t);if(!s){i.push(r);continue}o.has(s.base)||o.set(s.base,[]),o.get(s.base).push({viewName:r.view_name,suffix:s.suffix,parts:s.parts,ddl:r.ddl})}const u=[];for(const[r,s]of o){const f=groupByLogic(s,t);u.push({base:r,viewCount:s.length,groupCount:f.length,groups:f})}if(n)for(const r of i){const s=[{viewName:r.view_name,suffix:null,parts:null,ddl:r.ddl}];u.push({base:r.view_name,viewCount:1,groupCount:1,groups:groupByLogic(s,t),unmatched:!0})}return u.sort((r,s)=>s.groupCount-r.groupCount||r.base.localeCompare(s.base)),{bases:u,unmatched:i}}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __trimBase(e){for(var t=[],n=0;n<e.groups.length;n++){for(var o=e.groups[n],i=[],u=0;u<o.members.length;u++)i.push({viewName:o.members[u].viewName});t.push({suffixes:o.suffixes,members:i,sql:o.sql,params:o.params,miss:o.miss,missBy:o.missBy})}return{base:e.base,viewCount:e.viewCount,groupCount:e.groupCount,unmatched:e.unmatched,groups:t}}function __label(e){for(var t=[],n=0;n<e.suffixes.length;n++)t.push(e.suffixes[n]||e.members[n]&&e.members[n].viewName||"(suffix \u306A\u3057)");return t.join(", ")}function __payload(e){return{viewCount:0,groupCount:0,groupLabels:[],groupSizes:[],suffixes:[],unmatchedCount:0,bases:[],lead:e||"",tail:""}}function __run(e,t){var n=__opts(t);if(!e||e.length===0)return JSON.stringify(__payload("View \u304C\u6E21\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"));for(var o=[],i=0;i<e.length;i++)e[i]&&o.push({view_name:e[i].view_name,ddl:e[i].ddl});var u=analyze(o,n);if(u.bases.length===0){var r=__payload(o.length+" \u4EF6\u3059\u3079\u3066 suffix \u3092\u8A8D\u8B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002suffixParts / suffixList / suffixPattern \u306E\u6307\u5B9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return r.unmatchedCount=u.unmatched.length,JSON.stringify(r)}for(var s=__payload(""),f=0;f<u.bases.length;f++){var l=u.bases[f];s.bases.push(__trimBase(l)),s.viewCount+=l.viewCount,s.groupCount+=l.groupCount;for(var a=0;a<l.groups.length;a++){var c=l.groups[a];s.groupLabels.push(__label(c)),s.groupSizes.push(c.members.length);for(var h=0;h<c.suffixes.length;h++)s.suffixes.push(c.suffixes[h]||c.members[h].viewName)}}return s.suffixes.sort(),s.unmatchedCount=u.unmatched.length,u.unmatched.length>0&&n.includeUnmatched===!1&&(s.tail="suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u304C "+u.unmatched.length+" \u4EF6\u3042\u308A\u307E\u3059\u3002"),JSON.stringify(s)}return __run(views,options_json);

""";

DECLARE js_render STRING DEFAULT r"""
var x=Object.defineProperty;var f=Object.getOwnPropertySymbols;var b=Object.prototype.hasOwnProperty,v=Object.prototype.propertyIsEnumerable;var h=(e,n,t)=>n in e?x(e,n,{enumerable:!0,configurable:!0,writable:!0,value:t}):e[n]=t,u=(e,n)=>{for(var t in n||(n={}))b.call(n,t)&&h(e,t,n[t]);if(f)for(var t of f(n))v.call(n,t)&&h(e,t,n[t]);return e};const MAX_TABS=12,OUTER_TABS=["note","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","\u53C2\u7167\u95A2\u4FC2","\u30AB\u30E9\u30E0\u5B9A\u7FA9"],NOTE_MARK="<!--VG_NOTE-->";function hashId(e){let n=2166136261;for(let t=0;t<String(e).length;t++)n^=String(e).charCodeAt(t),n=Math.imul(n,16777619)>>>0;return n.toString(36)}const label=e=>e.suffixes.map((n,t)=>n||e.members[t]&&e.members[t].viewName||"(suffix \u306A\u3057)").join(", ");function badge(e,n,t){return`<span class="vg-badge" style="color:${n};background:${t}">${esc(e)}</span>`}function header(e,n,t,r){const o=t>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${n} View`,"#57606A","#EAEEF2")+badge(`${t} \u30B0\u30EB\u30FC\u30D7`,o?"#9A6700":"#1A7F37",o?"#FFF8C5":"#DAFBE1")+(r?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e;function referenceIndex(e,n){const t=(e.groups||[]).length,r=Math.trunc(Number((n||{}).referenceIndex));return Number.isFinite(r)&&r>=0&&r<t?r:0}function wrapPage(e,n,t,r){const o=r||{},s="vgo"+hashId(o.base||""),i=[`<div class="vg-root">${NOTE_MARK}</div>`,e,n,t],l=OUTER_TABS.map((p,g)=>`<input class="vg-or vg-or${g+1}" type="radio" name="${s}" id="${s}-${g+1}"${g===0?" checked":""}>`).join(""),a=OUTER_TABS.map((p,g)=>`<label class="vg-otab vg-ot${g+1}" for="${s}-${g+1}">${esc(p)}</label>`).join(""),d=OUTER_TABS.map((p,g)=>`<div class="vg-opanel vg-op${g+1}">${i[g]||""}</div>`).join(""),c=o.base?header(o.base,o.viewCount,(o.groups||[]).length,o.unmatched):"";return`<div class="vg-outer">${l}<div class="vg-otablist">${c}${a}</div><div class="vg-opanels">${d}</div></div>`}function diffLines(e,n){const t=e.length,r=n.length,o=[];for(let a=0;a<=t;a++)o.push(new Int32Array(r+1));for(let a=t-1;a>=0;a--)for(let d=r-1;d>=0;d--)o[a][d]=e[a]===n[d]?o[a+1][d+1]+1:Math.max(o[a+1][d],o[a][d+1]);const s=[];let i=0,l=0;for(;i<t&&l<r;)e[i]===n[l]?(s.push({type:"equal",aIndex:i,bIndex:l,text:e[i]}),i++,l++):o[i+1][l]>=o[i][l+1]?(s.push({type:"del",aIndex:i,text:e[i]}),i++):(s.push({type:"add",bIndex:l,text:n[l]}),l++);for(;i<t;)s.push({type:"del",aIndex:i,text:e[i]}),i++;for(;l<r;)s.push({type:"add",bIndex:l,text:n[l]}),l++;return s}function lcsMatchFlags(e,n){const t=e.length,r=n.length,o=[];for(let a=0;a<=t;a++)o.push(new Int32Array(r+1));for(let a=t-1;a>=0;a--)for(let d=r-1;d>=0;d--)o[a][d]=e[a]===n[d]?o[a+1][d+1]+1:Math.max(o[a+1][d],o[a][d+1]);const s=new Array(t).fill(!1);let i=0,l=0;for(;i<t&&l<r;)e[i]===n[l]?(s[i]=!0,i++,l++):o[i+1][l]>=o[i][l+1]?i++:l++;return s}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const n=[];for(const t of e){const r=n[n.length-1];r&&r.hi===t.hi?r.text+=t.text:n.push({text:t.text,hi:t.hi})}return n}function segDiff(e,n){const t=e.length,r=n.length,o=[];for(let d=0;d<=t;d++)o.push(new Int32Array(r+1));for(let d=t-1;d>=0;d--)for(let c=r-1;c>=0;c--)o[d][c]=e[d]===n[c]?o[d+1][c+1]+1:Math.max(o[d+1][c],o[d][c+1]);const s=[],i=[];let l=0,a=0;for(;l<t&&a<r;)e[l]===n[a]?(s.push({text:e[l],hi:!1}),i.push({text:n[a],hi:!1}),l++,a++):o[l+1][a]>=o[l][a+1]?(s.push({text:e[l],hi:!0}),l++):(i.push({text:n[a],hi:!0}),a++);for(;l<t;)s.push({text:e[l],hi:!0}),l++;for(;a<r;)i.push({text:n[a],hi:!0}),a++;return{oldSegs:mergeSegs(s),newSegs:mergeSegs(i)}}function wordDiff(e,n){return segDiff(tokenize(e),tokenize(n))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(a=>[{text:String(a),hi:!1}]);if(e.length===2){const a=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[a.oldSegs,a.newSegs]}const n=tokenizeName(e[0]),t=tokenizeName(e[1]),r=tokenizeName(e[2]),o=segDiff(n,t).newSegs,s=segDiff(n,r).newSegs,i=new Array(n.length).fill(!0);for(const a of[t,r]){const d=lcsMatchFlags(n,a);for(let c=0;c<n.length;c++)i[c]=i[c]&&d[c]}return[mergeSegs(n.map((a,d)=>({text:a,hi:!i[d]}))),o,s]}function build2Way(e,n){const t=diffLines(e,n),r=[];let o=0;for(;o<t.length;){if(t[o].type==="equal"){const a=t[o];r.push({type:"equal",left:{num:a.aIndex+1,segs:[{text:a.text,hi:!1}],kind:"plain"},right:{num:a.bIndex+1,segs:[{text:a.text,hi:!1}],kind:"plain"}}),o++;continue}const s=[];for(;o<t.length&&t[o].type==="del";)s.push(t[o++]);const i=[];for(;o<t.length&&t[o].type==="add";)i.push(t[o++]);const l=Math.max(s.length,i.length);for(let a=0;a<l;a++){const d=s[a],c=i[a];if(d&&c){const p=wordDiff(d.text,c.text);r.push({type:"mod",left:{num:d.aIndex+1,segs:p.oldSegs,kind:"del"},right:{num:c.bIndex+1,segs:p.newSegs,kind:"add"}})}else d?r.push({type:"del",left:{num:d.aIndex+1,segs:[{text:d.text,hi:!1}],kind:"del"},right:null}):r.push({type:"add",left:null,right:{num:c.bIndex+1,segs:[{text:c.text,hi:!1}],kind:"add"}})}}return r}function splitLines(e){const n=String(e).split(/\r\n|\r|\n/);return n.length>1&&n[n.length-1]===""&&n.pop(),n}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=u({},DEFAULTS.T),PANES,S=u({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(t=>t+t).join(""));const n=parseInt(e,16);return[n>>16&255,n>>8&255,n&255]}function toHex(e,n,t){const r=o=>("0"+Math.round(Math.max(0,Math.min(255,o))).toString(16)).slice(-2);return"#"+r(e)+r(n)+r(t)}function mixWhite(e,n){const[t,r,o]=hexToRgb(e),s=i=>255+(i-255)*n;return toHex(s(t),s(r),s(o))}function darken(e,n){const[t,r,o]=hexToRgb(e),s=i=>i*(1-n);return toHex(s(t),s(r),s(o))}function buildPane(e,n,t){return{bg:mixWhite(e,n),hi:mixWhite(e,t),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=u({},DEFAULTS.T),S=u({},DEFAULTS.S);const n=u({},DEFAULTS.paneColors);let t=DEFAULTS.lineOpacity,r=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const o=e.colors||{};HEX.test(o.baseColor||"")&&(n.base=o.baseColor),HEX.test(o.afterColor||"")&&(n.after=o.afterColor),HEX.test(o.refColor||"")&&(n.ref=o.refColor),isNum(e.diffLineOpacity)&&(t=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(r=e.diffCharOpacity);const s=e.syntax||{};s.keyword&&(S.keyword=s.keyword),s.literal&&(S.literal=s.literal),s.comment&&(S.comment=s.comment)}PANES={base:buildPane(n.base,t,r),after:buildPane(n.after,t,r),ref:buildPane(n.ref,t,r)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function esc(e){return String(e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function escAttr(e){return esc(e).replace(/"/g,"&quot;")}const PARAM_HTML_RE=/\{(?:<[^>]+>)*\{(?:<[^>]+>)*(P\d+)(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g;function withTips(e,n,t){if(!n)return e;const r=t?"vg-ph vg-phr":"vg-ph";return e.replace(PARAM_HTML_RE,(o,s)=>{const i=n[s];return i?`<span class="${r}" data-tip="${escAttr(i)}">${o}</span>`:o})}function sqlHighlight(e){const n=e.length;let t=0,r="";const o=(c,p,g)=>`<span style="color:${c};${g?"font-style:italic;":""}">${esc(p)}</span>`,s=c=>c===" "||c==="	",i=c=>c>="0"&&c<="9",l=c=>/[A-Za-z_]/.test(c),a=c=>/[A-Za-z0-9_]/.test(c),d=c=>"=<>!+-*/%|,.();:".indexOf(c)>=0;for(;t<n;){const c=e[t];if(s(c)){let p=t+1;for(;p<n&&s(e[p]);)p++;r+=esc(e.slice(t,p)),t=p;continue}if(c==="-"&&e[t+1]==="-"){r+=o(S.comment,e.slice(t),!0);break}if(c==="'"){let p=t+1;for(;p<n;){if(e[p]==="'"){if(e[p+1]==="'"){p+=2;continue}p++;break}p++}r+=o(S.literal,e.slice(t,p)),t=p;continue}if(i(c)){let p=t+1;for(;p<n&&(i(e[p])||e[p]===".");)p++;r+=o(S.literal,e.slice(t,p)),t=p;continue}if(l(c)){let p=t+1;for(;p<n&&a(e[p]);)p++;const g=e.slice(t,p);SQL_KEYWORDS.has(g.toUpperCase())?r+=o(S.keyword,g):r+=esc(g),t=p;continue}r+=esc(c),t++}return r}function renderSegs(e,n,t,r){if(!e||!e.length)return"&nbsp;";let o="";for(const s of e){const i=sqlHighlight(s.text);o+=s.hi?`<span style="background:${n};border-radius:2px;">${i}</span>`:i}return o===""?"&nbsp;":withTips(o,t,r)}function numTd(e,n,t){const r=t?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${n.numBg};border-right:1px solid ${T.numBorder};${r}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,n){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,n,t){let r=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(r+=`background:${t.bg};border-left:2px solid ${t.bar};`),`<td style="${r}">${n||"&nbsp;"}</td>`}function hatchTd(e,n){const t=n?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${t}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${t}${T.hatch}">&nbsp;</td>`}function labelHtml(e,n){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(t=>t.hi?`<span style="background:${n.hi};border-radius:2px;">${esc(t.text)}</span>`:esc(t.text)).join("")}function th(e,n,t,r,o){const s=o?`border-left:1px solid ${T.border};`:"",i=t?`&nbsp;<span style="color:${r.headText};font-weight:400;">(${esc(t)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${r.headBg};border-bottom:2px solid ${r.bar};${s}padding:7px 12px;">${labelHtml(n,r)}${i}</th>`}function wrapTable(e,n,t,r){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:${r?"visible":"hidden"};font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${n}</tr></thead>
    <tbody>
${t}    </tbody>
  </table>
</div>
`}function renderFragment1(e,n,t,r,o){configure(r);const s='<colgroup><col style="width:40px"><col></colgroup>',i=th(2,e,n,PANES.base,!1);let l="";for(let a=0;a<t.length;a++)l+=`      <tr>${numTd(a+1,PANES.base,!1)}${codeTd("same",withTips(sqlHighlight(t[a]),o),PANES.base)}</tr>
`;return wrapTable(s,i,l,!!o)}function renderFragment2(e,n,t,r,o){configure(r);const s='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',i=nameDiff([e,n]),l=th(3,i[0],"before",PANES.base,!1)+th(3,i[1],"after",PANES.after,!0);let a="";for(const d of t){const c=d.left,p=d.right;let g="";c?g+=numTd(c.num,PANES.base,!1)+markTd(c.kind==="del"?"del":"blank",PANES.base)+codeTd(c.kind,renderSegs(c.segs,PANES.base.hi,o&&o.left),PANES.base):g+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),p?g+=numTd(p.num,PANES.after,!0)+markTd(p.kind==="add"?"add":"blank",PANES.after)+codeTd(p.kind,renderSegs(p.segs,PANES.after.hi,o&&o.right,!0),PANES.after):g+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),a+=`      <tr>${g}</tr>
`}return wrapTable(s,l,a,!!o)}function relabelPanes(e,n){let t=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(r,o,s)=>{const i=n[t++];return i==null?r:o+esc(i)+s})}const paneSub=e=>`${e.members.length} View`,REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u3067\u304D\u306A\u3044\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u5217\u540D\u30FB\u5225\u540D\u30FBCTE \u540D\u30FB\u4E88\u7D04\u8A9E\u306A\u3069\u3002\u7F6E\u63DB\u3057\u3066\u3088\u3044\u306E\u306F FROM / JOIN \u306E\u5B9F\u4F53\u540D\u3068\u5024\u3060\u3051\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e,n,t){const r=a=>String(a==null?"":a).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),o=a=>a.missBy?a.missBy[n]:a.miss,s=e.filter(a=>o(a)).map(a=>{const d=o(a).detail,c=d.reason==="length"?`${d.aLen} \u5BFE ${d.bLen}`:`<code class="vg-mcode">${esc(r(d.aText))}</code> \u2194 <code class="vg-mcode">${esc(r(d.bText))}</code><span class="vg-mkind">${esc(kindText(d.kind))}</span>`;return`<tr><th class="vg-mname">${esc(label(a))}</th><td class="vg-mvs">vs ${esc(t)}</td><td class="vg-mreason">${esc(REASON_TEXT[d.reason]||d.reason)}<br>${c}</td></tr>`}).join("");return s?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(a=>o(a)&&o(a).detail.reason==="not-substitutable"&&(o(a).detail.kind==="string"||o(a).detail.kind==="number"))?'<div class="vg-mhint">\u5024\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u3067\u306F\u5024\u306F\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u3066\u540C\u3058\u30B0\u30EB\u30FC\u30D7\u306B\u3059\u308B\u306E\u3067\u3001<code class="vg-mcode">substitutable</code> \u3092\u7D5E\u3063\u305F\u8A2D\u5B9A\u306B\u306A\u3063\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u306B\u623B\u3059\u306A\u3089 options_json \u304B\u3089 <code class="vg-mcode">"substitutable"</code> \u3092\u5916\u3057\u307E\u3059\u3002<br>\u7D5E\u3063\u305F\u307E\u307E\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>':""}<div class="vg-pblock"><table class="vg-ptable">${s}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(t=>{if(!t.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const r=t.params.map(o=>{const s=Object.entries(o.values).map(([l,a])=>`<div class="vg-pv"><span class="vg-psuf">${esc(l)}</span>${esc(a)}</div>`).join(""),i=`<span class="vg-mkind">${esc(kindText(o.kind))}</span>`;return`<tr><th class="vg-pname">${esc(o.name)}</th><td class="vg-pvals">${i}${s}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><table class="vg-ptable">${r}</table></div>`}).join("")}</details>`}function paramTips(e){const n={};for(const t of e.params)n[t.name]=`${t.name}: ${kindText(t.kind)}
`+Object.entries(t.values).map(([r,o])=>`${r||"(suffix \u306A\u3057)"} = ${o}`).join(`
`);return n}function pair(e,n,t){return relabelPanes(renderFragment2(label(e),label(n),build2Way(splitLines(e.sql),splitLines(n.sql)),t,{left:paramTips(e),right:paramTips(n)}),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(n)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,n,t,r){const o=e[n],s=e.filter((p,g)=>g!==n),i=s.slice(0,12),l=i.map((p,g)=>`<input class="vg-r vg-r${g+1}" type="radio" name="${r}" id="${r}-${g+1}"${g===0?" checked":""}>`).join(""),a=baseTab(o)+i.map((p,g)=>`<label class="vg-tab vg-t${g+1}" for="${r}-${g+1}">${esc(label(p))}<span class="vg-tabn">${p.members.length}</span></label>`).join(""),d=i.length?i.map((p,g)=>`<div class="vg-panel vg-p${g+1}">${pair(o,p,t)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(o),paneSub(o),splitLines(o.sql),t,paramTips(o))}</div>`;return(s.length>i.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D 12 \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${s.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${l}<div class="vg-tablist">${a}</div><div class="vg-panels">${d}</div></div>`}function renderBase(e,n){const t=n||{},r=e.groups,o=r.length,s=referenceIndex(e,t),i="vgt"+hashId(e.base+"|"+r.map(label).join("|")+"|"+s);let l;return o===0?l=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):l=(o>1?"":notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`))+tabs(r,s,t,i),'<div class="vg-root">'+header(e.base,e.viewCount,o,e.unmatched)+l+missTable(r,s,o>0?label(r[s]):"")+paramsTable(r)+"</div>"}function chromeCss(){const e=[".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font-weight:600;font-size:12px;line-height:1.8;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font-weight:600;font-size:12px;line-height:1.6;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}",".vg-ph{position:relative;margin:0 -2px;padding:0 2px;border-radius:3px;background:#F1E8FD;color:#6639BA;font-weight:700;box-shadow:inset 0 0 0 1px #CDB6F2;cursor:help}",".vg-ph:hover{background:#E4D3FB}",".vg-ph::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}",".vg-ph:hover::after{display:block}",".vg-ph.vg-phr::after{left:auto;right:0}",".vg-or{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-outer{max-height:min(100vh,640px);overflow:auto}",".vg-otablist,.vg-ohead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;position:sticky;top:0;z-index:5;background:#fff;margin:0 0 10px;padding:8px 0;box-shadow:0 1px 0 #EAEEF2}",".vg-otablist>.vg-header,.vg-ohead>.vg-header{flex:0 0 100%;margin:0}",".vg-ohead>.vg-otablist{position:static;padding:0;margin:0;box-shadow:none;flex:0 0 100%}",".vg-opanel .vg-header{display:none}",".vg-otab{display:inline-flex;align-items:center;padding:5px 16px;border:1px solid #D0D7DE;border-radius:16px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px}",".vg-otab:hover{background:#EAEEF2;color:#24292F}",".vg-opanel{display:none}",".vg-erdblock{margin:0 0 28px;border:1px solid #D0D7DE;border-radius:6px;background:#fff}",".vg-erdblock:last-child{margin-bottom:0}",".vg-erdhead{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid #EAEEF2;background:#F6F8FA;border-radius:6px 6px 0 0}",".vg-erdname{font-weight:600;color:#24292F;font-size:12px}",".vg-erdbox{overflow-x:auto;padding:6px 10px 10px}",".vg-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 10px;color:#57606A;font-size:11px}",".vg-lg{display:inline-flex;align-items:center;gap:5px}",".vg-lgm{display:inline-block;width:10px;height:10px;border-radius:2px;border:1px solid #8C96A0}",".vg-lgt{background:#C9A227;border-color:#8C6D3F}",".vg-lgc{background:#4E8FBF;border-color:#3F6D8C}",".vg-lgo{background:#8250DF;border-color:#6D3F8C}",".vg-lgd{display:inline-block;width:18px;border-top:1.5px dashed #8C96A0}"],n=[".vg-otablist > ",".vg-ohead > .vg-otablist > "];for(let t=1;t<=OUTER_TABS.length;t++)e.push(`.vg-or${t}:checked ~ .vg-opanels > .vg-op${t}{display:block}`),e.push(n.map(r=>`.vg-or${t}:checked ~ ${r}.vg-ot${t}`).join(",")+"{background:#24292F;border-color:#24292F;color:#fff}");for(let t=1;t<=12;t++)e.push(`.vg-r${t}:checked ~ .vg-panels > .vg-p${t}{display:block}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t}{background:#fff;border-color:#D0D7DE;color:#24292F}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t} .vg-tabn{background:#DDF4FF;color:#0969DA}`);return e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(n){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var n=2166136261,t=0;t<e.length;t++)n^=e.charCodeAt(t),n=Math.imul(n,16777619)>>>0;return"d"+n.toString(36)}function __split(e){var n={},t=e.replace(/ style="([^"]*)"/g,function(r,o){var s=__hashClass(o);return n[s]=o,' class="'+s+'"'});return{markup:t,rules:n}}function __rulesToCss(e){for(var n=Object.keys(e).sort(),t=[],r=0;r<n.length;r++)t.push("."+n[r]+"{"+e[n[r]]+"}");return t.join(`
`)}function __applyMode(e,n){if(n==="class")return __split(e).markup;if(n==="embed"){var t=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(t.rules)+`
</style>
`+t.markup}return e}function __run(e,n){var t=__opts(n),r;try{r=JSON.parse(e)}catch(l){r=null}if(!r)return __notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002");for(var o=r.lead?__notice(r.lead):"",s=r.bases||[],i=0;i<s.length;i++)o+=renderBase(s[i],t);return r.tail&&(o+=__notice(r.tail)),__applyMode(o,t.mode||"inline")}return __run(analysis_json,options_json);

""";

DECLARE js_page STRING DEFAULT r"""
var y=Object.defineProperty,R=Object.defineProperties;var C=Object.getOwnPropertyDescriptors;var I=Object.getOwnPropertySymbols;var L=Object.prototype.hasOwnProperty,M=Object.prototype.propertyIsEnumerable;var A=(e,t,s)=>t in e?y(e,t,{enumerable:!0,configurable:!0,writable:!0,value:s}):e[t]=s,T=(e,t)=>{for(var s in t||(t={}))L.call(t,s)&&A(e,s,t[s]);if(I)for(var s of I(t))M.call(t,s)&&A(e,s,t[s]);return e},$=(e,t)=>R(e,C(t));const MAX_TABS=12,OUTER_TABS=["note","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","\u53C2\u7167\u95A2\u4FC2","\u30AB\u30E9\u30E0\u5B9A\u7FA9"],NOTE_MARK="<!--VG_NOTE-->";function esc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(e){let t=2166136261;for(let s=0;s<String(e).length;s++)t^=String(e).charCodeAt(s),t=Math.imul(t,16777619)>>>0;return t.toString(36)}const label=e=>e.suffixes.map((t,s)=>t||e.members[s]&&e.members[s].viewName||"(suffix \u306A\u3057)").join(", ");function badge(e,t,s){return`<span class="vg-badge" style="color:${t};background:${s}">${esc(e)}</span>`}function header(e,t,s,n){const o=s>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${t} View`,"#57606A","#EAEEF2")+badge(`${s} \u30B0\u30EB\u30FC\u30D7`,o?"#9A6700":"#1A7F37",o?"#FFF8C5":"#DAFBE1")+(n?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e;function referenceIndex(e,t){const s=(e.groups||[]).length,n=Math.trunc(Number((t||{}).referenceIndex));return Number.isFinite(n)&&n>=0&&n<s?n:0}function wrapPage(e,t,s,n){const o=n||{},i="vgo"+hashId(o.base||""),r=[`<div class="vg-root">${NOTE_MARK}</div>`,e,t,s],l=OUTER_TABS.map((g,p)=>`<input class="vg-or vg-or${p+1}" type="radio" name="${i}" id="${i}-${p+1}"${p===0?" checked":""}>`).join(""),c=OUTER_TABS.map((g,p)=>`<label class="vg-otab vg-ot${p+1}" for="${i}-${p+1}">${esc(g)}</label>`).join(""),d=OUTER_TABS.map((g,p)=>`<div class="vg-opanel vg-op${p+1}">${r[p]||""}</div>`).join(""),u=o.base?header(o.base,o.viewCount,(o.groups||[]).length,o.unmatched):"";return`<div class="vg-outer">${l}<div class="vg-otablist">${u}${c}</div><div class="vg-opanels">${d}</div></div>`}const DQ="\\u0022",DQ3=DQ+DQ+DQ,TOKEN_RE=new RegExp(["(`[^`]*`)","([rbRB]{1,2}(?:'''[\\s\\S]*?'''|"+DQ3+"[\\s\\S]*?"+DQ3+"|'[^']*'|"+DQ+"[^"+DQ+"]*"+DQ+"))","('''[\\s\\S]*?''')","("+DQ3+"[\\s\\S]*?"+DQ3+")","('(?:\\\\.|''|[^'\\\\])*')","("+DQ+"(?:\\\\.|"+DQ+DQ+"|[^"+DQ+"\\\\])*"+DQ+")","(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(0[xX][0-9a-fA-F]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],s=String(e==null?"":e);let n;for(TOKEN_RE.lastIndex=0;(n=TOKEN_RE.exec(s))!==null;){let o;n[1]?o="quoted":n[2]||n[3]||n[4]||n[5]||n[6]?o="string":n[7]||n[8]?o="comment":n[9]?o="number":n[10]?o=KEYWORDS.has(n[10].toUpperCase())?"keyword":"ident":n[11]?o="space":o="punct",t.push({kind:o,text:n[0]})}return t}function stripOptionsClause(e){const t=[];let s=0;for(;s<e.length;){const n=e[s];if(n.kind==="keyword"&&n.text.toUpperCase()==="OPTIONS"){let o=s+1;for(;o<e.length&&e[o].kind==="space";)o++;if(o<e.length&&e[o].text==="("){let i=0,r=o;for(;r<e.length;r++)if(e[r].text==="(")i++;else if(e[r].text===")"&&(i--,i===0)){r++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();s=r;continue}}t.push(n),s++}return t}function markEntities(e){const t=e.slice(),s=i=>{let r=i+1;for(;r<t.length&&t[r].kind==="space";)r++;return r},n=[];let o=null;for(let i=0;i<t.length;i++){const r=t[i];if(r.kind==="space"||r.kind==="comment")continue;if(r.text==="("){n.push(o),o=null;continue}if(r.text===")"){n.pop(),o=null;continue}const l=r.text.toUpperCase();if(o=r.kind==="keyword"||r.kind==="ident"?l:null,r.kind!=="keyword"||l!=="FROM"&&l!=="JOIN"||n.length>0&&n[n.length-1]==="EXTRACT")continue;let c=s(i);for(;!(c>=t.length);){const d=t[c];if(d.kind==="quoted")t[c]={kind:"entity",text:d.text},c=s(c);else if(d.kind==="ident"){const u=[];let g=c;for(;;){u.push(g);const h=s(g);if(h<t.length&&t[h].text==="."){const f=s(h);if(f<t.length&&t[f].kind==="ident"){g=f;continue}}break}const p=s(g);if(p<t.length&&t[p].text==="(")break;for(const h of u)t[h]={kind:"entity",text:t[h].text};c=p}else break;if(c<t.length&&t[c].kind==="keyword"&&t[c].text.toUpperCase()==="AS"){const u=s(c);u<t.length&&(t[u].kind==="ident"||t[u].kind==="quoted")&&(c=s(u))}else c<t.length&&t[c].kind==="ident"&&(c=s(c));if(c<t.length&&t[c].text===","){c=s(c);continue}break}}return t}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/,DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001",BOX_W_MIN=130,BOX_W_MAX=380,NAME_CHAR_W=6.65,BOX_H=40,GAP_MIN=78,CHAR_W=6.5,LINE_H=14,GAP_Y=14,PAD=10,kw=e=>e&&e.kind==="keyword"?e.text.toUpperCase():null;function prepare(e){const t=[];let s=0;for(const n of markEntities(tokenizeSql(e)))n.kind==="space"||n.kind==="comment"||(n.text===")"&&s--,t.push({kind:n.kind,text:n.text,depth:s}),n.text==="("&&s++);return t}function cteRanges(e){const t=[];if(!(e[0]&&kw(e[0])==="WITH"))return{ctes:t,mainFrom:0};let s=1;for(;;){const n=e[s],o=e[s+1],i=e[s+2];if(!i||n.kind!=="ident"||kw(o)!=="AS"||i.text!=="(")break;const r=i.depth;let l=s+3;for(;l<e.length&&!(e[l].text===")"&&e[l].depth===r);)l++;if(t.push({name:n.text,from:s+3,to:l,depth:r+1}),s=l+1,e[s]&&e[s].text===","){s++;continue}break}return{ctes:t,mainFrom:s}}const STOP=new Set(["WHERE","GROUP","ORDER","QUALIFY","WINDOW","HAVING","UNION","INTERSECT","EXCEPT","LIMIT","SELECT","JOIN","FROM"]);function skipParen(e,t,s){const n=e[t].depth;let o=t+1;for(;o<s&&!(e[o].text===")"&&e[o].depth===n);)o++;return o+1}function readSource(e,t,s){if(t>=s)return{node:null,next:t};const n=e[t];if(n.text==="(")return{node:{name:"(\u30B5\u30D6\u30AF\u30A8\u30EA)",kind:"subquery"},next:skipParen(e,t,s)};if(kw(n)==="UNNEST"){let o=t+1,i="";if(e[o]&&e[o].text==="("){const r=e[o].depth;let l=o+1;for(;l<s&&!(e[l].text===")"&&e[l].depth===r);)i+=e[l].text,l++;o=l+1}return{node:{name:"UNNEST("+i+")",kind:"unnest"},next:o}}if(n.kind==="entity"||n.kind==="quoted"||n.kind==="ident"){const o=[];let i=t;for(;i<s&&(e[i].kind==="entity"||e[i].kind==="quoted"||e[i].kind==="ident");){if(o.push(e[i].text),i++,i<s&&e[i].text==="."){i++;continue}break}return i<s&&e[i].text==="("?{node:null,next:skipParen(e,i,s)}:{node:{name:o.join("."),kind:"ref"},next:i}}return{node:null,next:t+1}}function skipAlias(e,t,s){if(t<s&&kw(e[t])==="AS"){const n=e[t+1];return n&&(n.kind==="ident"||n.kind==="quoted")?t+2:t+1}return t<s&&e[t].kind==="ident"&&!STOP.has(e[t].text.toUpperCase())?t+1:t}function readOnKeys(e,t,s){const n=[];let o=t;for(;o<s;){const i=kw(e[o]);if(i&&STOP.has(i)||i==="LEFT"||i==="RIGHT"||i==="FULL"||i==="INNER"||i==="CROSS")break;if(e[o].text==="="){const r=(d,u,g)=>d&&u&&g&&u.text==="."?g.text:null,l=r(e[o-3],e[o-2],e[o-1]),c=r(e[o+1],e[o+2],e[o+3]);l&&c&&n.push(l===c?l:l+" = "+c)}o++}return{keys:n,next:o}}function readUsingKeys(e,t,s){const n=[];let o=t;if(e[o]&&e[o].text==="("){const i=e[o].depth;for(o++;o<s&&!(e[o].text===")"&&e[o].depth===i);)e[o].kind==="ident"&&n.push(e[o].text),o++;o++}return{keys:n,next:o}}function joinKind(e,t,s){for(let n=t-1;n>=s&&t-n<=3;n--){const o=kw(e[n]);if(o==="LEFT"||o==="RIGHT"||o==="FULL"||o==="CROSS")return o;if(o==="INNER")return"INNER"}return"INNER"}function scanScope(e,t,s,n){const o=[];for(let i=t;i<s;i++){const r=kw(e[i]);if(r!=="FROM"&&r!=="JOIN")continue;const l=e[i].depth>n,c=r==="JOIN"?joinKind(e,i,t):null;let d=i+1;for(;;){const u=readSource(e,d,s);if(d=u.next,u.node){d=skipAlias(e,d,s);let g=[];if(!l&&d<s&&kw(e[d])==="ON"){const p=readOnKeys(e,d+1,s);g=p.keys,d=p.next}else if(!l&&d<s&&kw(e[d])==="USING"){const p=readUsingKeys(e,d+1,s);g=p.keys,d=p.next}u.node.kind!=="unnest"&&o.push({name:u.node.name,kind:u.node.kind,joinType:c,keys:g,nested:l})}if(d<s&&e[d].text===","&&e[d].depth===e[i].depth){d++;continue}break}i=Math.max(i,d-1)}return o}function buildGraph(e,t){const s=new Map((t||[]).map(f=>[f.name,f])),n=f=>{const m=Object.keys(f.values);return m.length?f.values[m[0]]:null},o=new Map,i=String(e).replace(/\{\{(P\d+)\}\}/g,(f,m)=>{const k=s.get(m);if(!k)return f;const E=n(k);return E==null?f:(o.set(E,k),E)}),r=prepare(i),{ctes:l,mainFrom:c}=cteRanges(r),d=new Set(l.map(f=>f.name)),u=new Map,g=[],p=(f,m)=>{const k=m+":"+f;if(!u.has(k)){const E=[],a=o.get(String(f));if(a)E.push(a);else for(const x of String(f).split(".")){const v=o.get(x);v&&E.indexOf(v)<0&&E.push(v)}u.set(k,{id:k,name:f,label:f,kind:m,params:E})}return k},h=l.map(f=>({id:p(f.name,"cte"),from:f.from,to:f.to,depth:f.depth}));h.push({id:p("(\u6700\u7D42 SELECT)","output"),from:c,to:r.length,depth:0});for(const f of h)for(const m of scanScope(r,f.from,f.to,f.depth)){const k=m.kind==="ref"?d.has(m.name)?"cte":"table":m.kind,E=p(m.name,k);if(E===f.id)continue;const a=g.find(x=>x.from===E&&x.to===f.id);a?(a.keys.length||(a.keys=m.keys),a.joinType||(a.joinType=m.joinType),a.nested=a.nested&&m.nested):g.push({from:E,to:f.id,joinType:m.joinType,keys:m.keys,nested:m.nested})}return{nodes:[...u.values()],edges:g}}function layout(e){const{nodes:t,edges:s}=e,n=new Map(t.map(a=>[a.id,[]])),o=new Map(t.map(a=>[a.id,[]]));for(const a of s)n.has(a.to)&&n.get(a.to).push(a.from),o.has(a.from)&&o.get(a.from).push(a.to);const i=new Map(t.map(a=>[a.id,0]));for(let a=0;a<t.length+1;a++){let x=!1;for(const v of t){const N=n.get(v.id);if(!N.length)continue;const b=Math.max(...N.map(w=>i.get(w)||0))+1;b>i.get(v.id)&&(i.set(v.id,b),x=!0)}if(!x)break}const r=Math.max(0,...t.map(a=>i.get(a.id))),l=new Map(t.map(a=>[a.id,o.get(a.id).length?1/0:r]));for(let a=0;a<t.length+1;a++){let x=!1;for(const v of t){const N=o.get(v.id);if(!N.length)continue;const b=Math.min(...N.map(w=>l.get(w)));b-1<l.get(v.id)&&(l.set(v.id,b-1),x=!0)}if(!x)break}for(const a of t)Number.isFinite(l.get(a.id))||l.set(a.id,r);const c=[];for(const a of t){const x=Math.max(0,l.get(a.id));(c[x]||(c[x]=[])).push(a)}const d=new Map;c.forEach((a,x)=>{a&&(x>0&&a.sort((v,N)=>{const b=w=>{const F=n.get(w.id).filter(S=>d.has(S));return F.length?F.reduce((S,O)=>S+d.get(O),0)/F.length:Number.MAX_SAFE_INTEGER};return b(v)-b(N)}),a.forEach((v,N)=>d.set(v.id,N)))});const u=boxWidth(t),g=new Map;c.forEach((a,x)=>(a||[]).forEach(v=>g.set(v.id,x)));const p=new Array(Math.max(0,c.length-1)).fill(GAP_MIN);for(const a of s){const x=(g.get(a.to)||0)-1;x<0||x>=p.length||(p[x]=Math.max(p[x],linesWidth(edgeLines(a))+22))}const h=[];let f=PAD;for(let a=0;a<c.length;a++)h[a]=f,f+=u+(p[a]||0);const m=[];c.forEach((a,x)=>{(a||[]).forEach((v,N)=>{m.push($(T({},v),{x:h[x],y:PAD+N*(BOX_H+GAP_Y),w:u,h:BOX_H}))})});const k=new Map(m.map(a=>[a.id,a])),E=Math.max(1,...c.map(a=>(a||[]).length));return{nodes:m,edges:s.map(a=>$(T({},a),{a:k.get(a.from),b:k.get(a.to)})).filter(a=>a.a&&a.b),gaps:p,colOf:g,width:(h[c.length-1]||PAD)+u+PAD,height:PAD*2+E*BOX_H+Math.max(0,E-1)*GAP_Y+6}}const KIND={table:{text:"\u5B9F\u30C6\u30FC\u30D6\u30EB",fill:"#FFFFFF",stroke:"#8C6D3F",bar:"#C9A227"},cte:{text:"CTE",fill:"#FFFFFF",stroke:"#3F6D8C",bar:"#4E8FBF"},output:{text:"\u6700\u7D42 SELECT",fill:"#FFFFFF",stroke:"#6D3F8C",bar:"#8250DF"},subquery:{text:"\u30B5\u30D6\u30AF\u30A8\u30EA",fill:"#FFFFFF",stroke:"#6E7781",bar:"#9AA4AE"}},kindOf=e=>KIND[e]||KIND.subquery;function shortName(e){const t=String(e).replace(/`/g,""),s=t.lastIndexOf(".");return s>=0?t.slice(s+1):t}function boxWidth(e){let t=BOX_W_MIN;for(const s of e)t=Math.max(t,shortName(s.label).length*NAME_CHAR_W+24);return Math.min(t,BOX_W_MAX)}function fit(e,t){const s=String(e),n=Math.floor((t-24)/NAME_CHAR_W);return s.length>n?s.slice(0,n-1)+"\u2026":s}function edgeLines(e){const t=[];e.joinType&&t.push(e.joinType==="INNER"?"JOIN":e.joinType+" JOIN");for(const s of e.keys||[])t.push(s);return!t.length&&e.nested&&t.push("\u30B5\u30D6\u30AF\u30A8\u30EA"),t}function linesWidth(e){let t=0;for(const s of e)t=Math.max(t,s.length*CHAR_W);return t}function edgeLabel(e){const t=edgeLines(e);return t.length?t.length>1?t[0]+" / "+t.slice(1).join(", "):t[0]:""}function toSvg(e){const t=[];t.push(`<svg viewBox="0 0 ${e.width} ${e.height}" width="${e.width}" height="${e.height}" role="img" aria-label="\u53C2\u7167\u95A2\u4FC2\u56F3" xmlns="http://www.w3.org/2000/svg">`),t.push('<defs><marker id="vgarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8C96A0"/></marker></defs>');const s=[];for(const n of e.edges){const o=n.a.x+n.a.w,i=n.a.y+n.a.h/2,r=n.b.x,l=n.b.y+n.b.h/2,c=e.gaps&&e.gaps[(e.colOf.get(n.to)||0)-1]||GAP_MIN,d=r>o?r-c/2:o+c/2,u=`M${o},${i} H${d} V${l} H${r}`,g=edgeLines(n);t.push(`<path d="${u}" fill="none" stroke="#8C96A0" stroke-width="1.2" ${n.nested?'stroke-dasharray="4 3" ':""}marker-end="url(#vgarrow)">`+(g.length?`<title>${esc(edgeLabel(n))}</title>`:"")+"</path>"),g.length&&s.push({x:d,y:(i+l)/2,lines:g})}for(const n of s){const o=linesWidth(n.lines)+12,i=n.lines.length*LINE_H,r=n.y-i/2;t.push(`<rect x="${(n.x-o/2).toFixed(1)}" y="${r.toFixed(1)}" width="${o.toFixed(1)}" height="${i}" rx="2" fill="#FFFFFF" opacity="0.92"/>`);const l=n.lines.map((c,d)=>`<tspan x="${n.x}" y="${(r+LINE_H*d+11).toFixed(1)}">${esc(c)}</tspan>`).join("");t.push(`<text text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" fill="#57606A">${l}</text>`)}for(const n of e.nodes){const o=kindOf(n.kind),i=n.label+(n.params.length?`
`+n.params.map(r=>r.name+": "+Object.keys(r.values).map(l=>l+" = "+r.values[l]).join(" / ")).join(`
`):"");t.push(`<g><title>${esc(i)}</title>`),t.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5" fill="${o.fill}" stroke="${o.stroke}" stroke-width="1"/>`),t.push(`<rect x="${n.x}" y="${n.y}" width="4" height="${n.h}" rx="2" fill="${o.bar}"/>`),t.push(`<text x="${n.x+11}" y="${n.y+17}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" font-weight="600" fill="#24292F">${esc(fit(shortName(n.label),n.w))}</text>`),t.push(`<text x="${n.x+11}" y="${n.y+31}" font-family="Roboto,system-ui,sans-serif" font-size="9" fill="#8C96A0">${esc(o.text)}${n.params.length?" \u30FB\u30D1\u30E9\u30E1\u30FC\u30BF":""}</text>`),t.push("</g>")}return t.push("</svg>"),t.join("")}function groupSvg(e){return toSvg(layout(buildGraph(e.sql,e.params)))}function erdStack(e,t){return[e[t],...e.filter((n,o)=>o!==t)].map((n,o)=>'<div class="vg-erdblock"><div class="vg-erdhead">'+(o===0?'<span class="vg-tbadge">\u57FA\u6E96</span>':"")+`<span class="vg-erdname">${esc(label(n))}</span><span class="vg-tabn">${n.members.length}</span></div><div class="vg-erdbox">${groupSvg(n)}</div></div>`).join("")}function erdLegend(){const e=(t,s)=>`<span class="vg-lg"><span class="vg-lgm ${t}"></span>${esc(s)}</span>`;return'<div class="vg-legend">'+e("vg-lgt","\u5B9F\u30C6\u30FC\u30D6\u30EB")+e("vg-lgc","CTE")+e("vg-lgo","\u6700\u7D42 SELECT")+'<span class="vg-lg"><span class="vg-lgd"></span>\u30B5\u30D6\u30AF\u30A8\u30EA\u7D4C\u7531\u306E\u53C2\u7167</span></div>'}function renderErd(e,t){return e.groups.length?notice("FROM / JOIN \u304B\u3089\u8D77\u3053\u3057\u305F\u53C2\u7167\u95A2\u4FC2\u3067\u3059\u3002\u77E2\u5370\u306F\u300C\u8AAD\u3093\u3067\u4F5C\u308B\u300D\u5411\u304D\u3001\u6CE8\u8A18\u306F JOIN \u306E\u7A2E\u5225\u3068\u7D50\u5408\u30AD\u30FC\u3002\u30AB\u30FC\u30C7\u30A3\u30CA\u30EA\u30C6\u30A3\u3068\u4E3B\u30AD\u30FC\u306F SQL \u304B\u3089\u306F\u5206\u304B\u3089\u306A\u3044\u306E\u3067\u63CF\u3044\u3066\u3044\u307E\u305B\u3093\u3002\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u540D\u524D\u306F\u3001\u57FA\u6E96\u306E View \u306E\u5024\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002")+erdLegend()+erdStack(e.groups,t):notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002")}function renderErdBase(e,t){return'<div class="vg-root">'+header(e.base,e.viewCount,e.groups.length,e.unmatched)+renderErd(e,referenceIndex(e,t))+"</div>"}const WARN="\u26A0";function groupColumns(e,t){const s=new Map,n=e.members||[];for(let o=0;o<n.length;o++){const i=n[o],r=e.suffixes&&e.suffixes[o]||i.viewName,l=t[i.viewName]||[];for(let c=0;c<l.length;c++){const d=l[c];let u=s.get(d.n);u||(u={name:d.n,desc:"",order:c,vals:[]},s.set(d.n,u)),!u.desc&&d.d&&(u.desc=d.d),u.vals.push({suffix:r,type:d.t,ord:d.o==null?c+1:d.o,nullable:d.u==null||d.u===""?null:String(d.u).toUpperCase()!=="NO"})}}return s}function columnOrder(e,t,s){const n=new Set,o=[],i=r=>{const l=[...r.values()].sort((c,d)=>c.order-d.order);for(const c of l)n.has(c.name)||(n.add(c.name),o.push(c.name))};i(t[s]);for(let r=0;r<e.length;r++)r!==s&&i(t[r]);return o}const nullText=e=>e===null?"NULL \u4E0D\u660E":e?"NULL \u53EF":"NOT NULL";function uniq(e){const t=[];for(const s of e)t.indexOf(s)<0&&t.push(s);return t}function cellInfo(e,t){if(!e)return{text:null,meta:"",sig:null,mixed:!1};const s=uniq(e.vals.map(r=>r.type)),n=uniq(e.vals.map(r=>r.ord)),o=uniq(e.vals.map(r=>nullText(r.nullable))),i=uniq(e.vals.map(r=>`${r.ord}|${r.type}|${r.nullable}`)).length>1||e.vals.length!==t;return{text:s.join(" / "),meta:`#${n.join(" / ")} \xB7 ${o.join(" / ")}`,sig:s.join(" / ")+"|"+o.join(" / "),mixed:i}}function mixedTip(e,t){const s=e.vals.map(o=>`${o.suffix} = #${o.ord} ${o.type} ${nullText(o.nullable)}`),n=e.vals.map(o=>o.suffix);for(let o=0;o<(t.members||[]).length;o++){const i=t.suffixes&&t.suffixes[o]||t.members[o].viewName;n.indexOf(i)<0&&s.push(`${i} = (\u3053\u306E\u5217\u3092\u6301\u305F\u306A\u3044)`)}return s.join(`
`)}function renderColumns(e,t,s){const n=e.groups||[];if(!n.length)return notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");const o=referenceIndex(e,s||{}),i=n.map(h=>groupColumns(h,t||{})),r=columnOrder(n,i,o);if(!r.length)return notice("\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.COLUMNS \u304B\u3089\u5217\u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");const l=[o].concat(n.map((h,f)=>f).filter(h=>h!==o));let c=0,d=0;const u=r.map(h=>{const f=cellInfo(i[o].get(h),n[o].members.length),m=i[o].get(h)||l.map(a=>i[a].get(h)).filter(a=>a)[0],k=l.map((a,x)=>{const v=n[a],N=i[a].get(h),b=cellInfo(N,v.members.length),w=["vg-ccell"];b.text?x>0&&b.sig!==f.sig&&(w.push("vg-cdiff"),c++):w.push("vg-cnone"),b.mixed&&(w.push("vg-cmix"),d++);const F=b.text?esc(b.text)+(b.mixed?`<span class="vg-cwarn" data-tip="${esc(mixedTip(N,v))}">${WARN}</span>`:"")+`<div class="vg-cmeta">${esc(b.meta)}</div>`:"\u2014";return`<td class="${w.join(" ")}">${F}</td>`}).join(""),E=m&&m.desc?`<div class="vg-cdesc">${esc(m.desc)}</div>`:"";return`<tr><th class="vg-cname">${esc(h)}${E}</th>${k}</tr>`}).join(""),g=l.map((h,f)=>`<th class="vg-chead${f===0?" vg-cref":""}">`+(f===0?'<span class="vg-tbadge">\u57FA\u6E96</span>':"")+`${esc(label(n[h]))}<span class="vg-tabn">${n[h].members.length}</span></th>`).join(""),p=[];return d&&p.push(notice(`\u540C\u3058\u30B0\u30EB\u30FC\u30D7\u306E\u4E2D\u3067\u578B\u30FBNULL \u5236\u7D04\u30FB\u4E26\u3073\u9806\u304C\u63C3\u3063\u3066\u3044\u306A\u3044\u7B87\u6240\u304C ${d} \u4EF6\u3042\u308A\u307E\u3059\uFF08${WARN} \u306E\u5370\uFF09\u3002SQL \u304C\u540C\u4E00\u3067\u3082\u53C2\u7167\u5148\u30C6\u30FC\u30D6\u30EB\u306E\u578B\u304C\u9055\u3048\u3070\u3053\u3046\u306A\u308B\u306E\u3067\u3001\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206\u306B\u306F\u51FA\u3066\u304D\u307E\u305B\u3093\u3002`)),c&&p.push(notice(`\u57FA\u6E96\u30B0\u30EB\u30FC\u30D7\u3068\u578B\u307E\u305F\u306F NULL \u5236\u7D04\u304C\u9055\u3046\u7B87\u6240\u304C ${c} \u4EF6\u3042\u308A\u307E\u3059\uFF08\u8272\u4ED8\u304D\u306E\u30BB\u30EB\uFF09\u3002\u4E26\u3073\u9806\uFF08#\uFF09\u306E\u9055\u3044\u306B\u306F\u8272\u3092\u4ED8\u3051\u3066\u3044\u307E\u305B\u3093\uFF08\u5217\u3092 1 \u672C\u8DB3\u3059\u3068\u4EE5\u964D\u304C\u307E\u3068\u3081\u3066\u305A\u308C\u3001\u578B\u306E\u5DEE\u304C\u57CB\u3082\u308C\u308B\u305F\u3081\uFF09\u3002`)),p.length||p.push(notice("\u5168\u30B0\u30EB\u30FC\u30D7\u3067\u5217\u540D\u30FB\u578B\u30FBNULL \u5236\u7D04\u304C\u4E00\u81F4\u3057\u3066\u3044\u307E\u3059\u3002")),p.join("")+`<div class="vg-ctablewrap"><table class="vg-ctable"><thead><tr><th class="vg-chead vg-cnamehead">\u5217\u540D</th>${g}</tr></thead><tbody>${u}</tbody></table></div>`}function renderColumnsBase(e,t,s){return`<div class="vg-root">${renderColumns(e,t,s)}</div>`}function columnsCss(){return[".vg-ctablewrap{overflow-x:auto}",".vg-ctable{border-collapse:collapse;font-size:12px}",".vg-chead{position:sticky;top:0;z-index:1;padding:6px 12px;border:1px solid #D0D7DE;background:#F6F8FA;color:#24292F;font-weight:600;text-align:left;white-space:nowrap}",".vg-cref{background:#fbeded;border-color:#efb6b6}",".vg-cnamehead{min-width:180px}",".vg-cname{padding:5px 12px;border:1px solid #D0D7DE;text-align:left;vertical-align:top;font-weight:600;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-cdesc{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:400;color:#57606A;white-space:normal;max-width:320px}",".vg-ccell{padding:5px 12px;border:1px solid #D0D7DE;vertical-align:top;white-space:nowrap;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-cmeta{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;color:#57606A}",".vg-cdiff{background:#dfe7d2}",".vg-cnone{color:#8C959F;background:#FAFAFA}",".vg-cmix{box-shadow:inset 0 0 0 2px #D4A72C}",".vg-cwarn{position:relative;margin-left:6px;color:#9A6700;cursor:help}",".vg-cwarn::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}",".vg-cwarn:hover::after{display:block}"].join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __run(e,t,s,n){var o=__opts(n),i;try{i=JSON.parse(e)}catch(h){i=null}if(!i)return String(t||__notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002"));var r={};try{for(var l=JSON.parse(s)||[],c=0;c<l.length;c++)r[l[c].v]=l[c].cols||[]}catch(h){r={}}for(var d="",u="",g=i.bases||[],p=0;p<g.length;p++)d+=renderErdBase(g[p],o),u+=renderColumnsBase(g[p],r,o);return d||(d=__notice("\u56F3\u306B\u3067\u304D\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002")),u||(u=__notice("\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3092\u51FA\u305B\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002")),wrapPage(String(t||""),d,u,i.bases&&i.bases.length?i.bases[0]:null)}return __run(analysis_json,diff_html,columns_json,options_json);

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
.vg-or{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-outer{max-height:min(100vh,640px);overflow:auto}
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
.vg-ctablewrap{overflow-x:auto}
.vg-ctable{border-collapse:collapse;font-size:12px}
.vg-chead{position:sticky;top:0;z-index:1;padding:6px 12px;border:1px solid #D0D7DE;background:#F6F8FA;color:#24292F;font-weight:600;text-align:left;white-space:nowrap}
.vg-cref{background:#fbeded;border-color:#efb6b6}
.vg-cnamehead{min-width:180px}
.vg-cname{padding:5px 12px;border:1px solid #D0D7DE;text-align:left;vertical-align:top;font-weight:600;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-cdesc{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:400;color:#57606A;white-space:normal;max-width:320px}
.vg-ccell{padding:5px 12px;border:1px solid #D0D7DE;vertical-align:top;white-space:nowrap;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-cmeta{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;color:#57606A}
.vg-cdiff{background:#dfe7d2}
.vg-cnone{color:#8C959F;background:#FAFAFA}
.vg-cmix{box-shadow:inset 0 0 0 2px #D4A72C}
.vg-cwarn{position:relative;margin-left:6px;color:#9A6700;cursor:help}
.vg-cwarn::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}
.vg-cwarn:hover::after{display:block}
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
-- 3. viewlgc_page
--    参照関係の図を作り、渡された差分 HTML と外側タブで束ねて 1 枚にする
--
-- タブは左から note / ロジック差分 / 参照関係 / カラム定義 で、既定で開くのは note。
-- カラム定義は columns_json（INFORMATION_SCHEMA.COLUMNS を base ごとにまとめた
-- もの）から作る。取れなくても落とさず、そのタブだけ案内にする。
-- 差分は作らない。viewlgc_render の出力をそのまま受け取って包むだけ。
-- 図の解析にはトークナイザが要るので、差分側とは別の UDF にしてある
-- （両方を 1 つに積むとインラインの 32 KB に収まらない）。
--
-- メモの中身もここでは入れない。パネルには目印 '<!--VG_NOTE-->' だけを置き、
-- ビューが REPLACE で note_html に差し替える。ここで焼き込むと、シートを
-- 直しても次の日次実行までレポートが古いままになる。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  analysis_json STRING,
  diff_html STRING,
  columns_json STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_page_function_name,
  TO_JSON_STRING(js_page));


-- ---------------------------------------------------------------------
-- 4. viewlgc_markdown
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
-- 5. viewlgc_group_css
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
-- 6. viewlgc_render_dynamic_sql
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
--   __T_DIFF_HIST__        履歴テーブル（project.dataset.table）
--   __T_BASE_NOTE__        base ごとのメモの外部テーブル（同上）
--   __V_DIFF__             最新スナップショットのビュー（基準 = 先頭グループ）
--   __V_DIFF_BY_REF__      同上。基準ごとに 1 行あるほう
--   __UDF_ANALYZE__        analyze 関数（project.dataset.function）
--   __UDF_RENDER__         render 関数（同上）
--   __UDF_PAGE__           page 関数（同上）
--   __UDF_MARKDOWN__       markdown 関数（同上）
--   __UDF_CSS__            group_css 関数（同上）
--   __TZ__                 snapshot_date の基準タイムゾーン
--   __RETENTION_DAYS__     パーティションの保持日数
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
    diff_hist         STRING,
    diff_latest       STRING,
    diff_by_ref       STRING,
    base_note         STRING,
    analyze_function  STRING,
    render_function   STRING,
    page_function     STRING,
    markdown_function STRING,
    css_function      STRING
  >,
  options STRUCT<
    time_zone        STRING,
    retention_days   STRING,
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
    '__T_DIFF_HIST__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_hist),
    '__T_BASE_NOTE__',
      work_project_id || '.' || work_dataset || '.' || objects.base_note),
    '__V_DIFF_BY_REF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_by_ref),
    '__V_DIFF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_latest),
    '__UDF_ANALYZE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.analyze_function),
    '__UDF_RENDER__',
      udf_project_id || '.' || udf_dataset || '.' || objects.render_function),
    '__UDF_PAGE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.page_function),
    '__UDF_MARKDOWN__',
      udf_project_id || '.' || udf_dataset || '.' || objects.markdown_function),
    '__UDF_CSS__',
      udf_project_id || '.' || udf_dataset || '.' || objects.css_function),
    '__TZ__', options.time_zone),
    '__RETENTION_DAYS__', options.retention_days),
    '__SUFFIX_PATTERN__', options.suffix_pattern),
    '__NOTE_SHEET_URL__', options.note_sheet_url),
    '__NOTE_SHEET_RANGE__', options.note_sheet_range),
    '__SCHEMA_COND__', conditions.schema_condition),
    '__VIEW_DATASET_COND__', conditions.view_dataset_condition),
    '__VIEW_NAME_COND__', conditions.view_name_condition)
)
''',
  udf_project_id, udf_dataset, udf_sql_function_name);


-- 作った 6 つの名前を出す。build_table.sql に同じ値を入れる。
SELECT
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_analyze_function_name)  AS analyze_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_render_function_name)   AS render_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_page_function_name)     AS page_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_markdown_function_name) AS markdown_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_css_function_name)      AS css_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_sql_function_name)      AS sql_function,
  CURRENT_TIMESTAMP() AS created_at;
END;
