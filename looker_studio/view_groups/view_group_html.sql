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
DECLARE udf_css_p1_function_name STRING;
DECLARE udf_css_p2_function_name STRING;
DECLARE udf_css_p3_function_name STRING;
DECLARE udf_css_p4_function_name STRING;
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
var E=Object.defineProperty,k=Object.defineProperties;var A=Object.getOwnPropertyDescriptors;var m=Object.getOwnPropertySymbols;var T=Object.prototype.hasOwnProperty,C=Object.prototype.propertyIsEnumerable;var S=(n,t,s)=>t in n?E(n,t,{enumerable:!0,configurable:!0,writable:!0,value:s}):n[t]=s,g=(n,t)=>{for(var s in t||(t={}))T.call(t,s)&&S(n,s,t[s]);if(m)for(var s of m(t))C.call(t,s)&&S(n,s,t[s]);return n},x=(n,t)=>k(n,A(t));const DQ="\\u0022",DQ3=DQ+DQ+DQ,TOKEN_RE=new RegExp(["(`[^`]*`)","([rbRB]{1,2}(?:'''[\\s\\S]*?'''|"+DQ3+"[\\s\\S]*?"+DQ3+"|'[^']*'|"+DQ+"[^"+DQ+"]*"+DQ+"))","('''[\\s\\S]*?''')","("+DQ3+"[\\s\\S]*?"+DQ3+")","('(?:\\\\.|''|[^'\\\\])*')","("+DQ+"(?:\\\\.|"+DQ+DQ+"|[^"+DQ+"\\\\])*"+DQ+")","(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(0[xX][0-9a-fA-F]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(n){const t=[],s=String(n==null?"":n);let o;for(TOKEN_RE.lastIndex=0;(o=TOKEN_RE.exec(s))!==null;){let r;o[1]?r="quoted":o[2]||o[3]||o[4]||o[5]||o[6]?r="string":o[7]||o[8]?r="comment":o[9]?r="number":o[10]?r=KEYWORDS.has(o[10].toUpperCase())?"keyword":"ident":o[11]?r="space":r="punct",t.push({kind:r,text:o[0]})}return t}function stripOptionsClause(n){const t=[];let s=0;for(;s<n.length;){const o=n[s];if(o.kind==="keyword"&&o.text.toUpperCase()==="OPTIONS"){let r=s+1;for(;r<n.length&&n[r].kind==="space";)r++;if(r<n.length&&n[r].text==="("){let f=0,e=r;for(;e<n.length;e++)if(n[e].text==="(")f++;else if(n[e].text===")"&&(f--,f===0)){e++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();s=e;continue}}t.push(o),s++}return t}function markEntities(n){const t=n.slice(),s=f=>{let e=f+1;for(;e<t.length&&t[e].kind==="space";)e++;return e},o=[];let r=null;for(let f=0;f<t.length;f++){const e=t[f];if(e.kind==="space"||e.kind==="comment")continue;if(e.text==="("){o.push(r),r=null;continue}if(e.text===")"){o.pop(),r=null;continue}const i=e.text.toUpperCase();if(r=e.kind==="keyword"||e.kind==="ident"?i:null,e.kind!=="keyword"||i!=="FROM"&&i!=="JOIN"||o.length>0&&o[o.length-1]==="EXTRACT")continue;let u=s(f);for(;!(u>=t.length);){const c=t[u];if(c.kind==="quoted")t[u]={kind:"entity",text:c.text},u=s(u);else if(c.kind==="ident"){const a=[];let l=u;for(;;){a.push(l);const p=s(l);if(p<t.length&&t[p].text==="."){const d=s(p);if(d<t.length&&t[d].kind==="ident"){l=d;continue}}break}const h=s(l);if(h<t.length&&t[h].text==="(")break;for(const p of a)t[p]={kind:"entity",text:t[p].text};u=h}else break;if(u<t.length&&t[u].kind==="keyword"&&t[u].text.toUpperCase()==="AS"){const a=s(u);a<t.length&&(t[a].kind==="ident"||t[a].kind==="quoted")&&(u=s(a))}else u<t.length&&t[u].kind==="ident"&&(u=s(u));if(u<t.length&&t[u].text===","){u=s(u);continue}break}}return t}function normalizeSpace(n){return n.map(t=>t.kind==="space"?{kind:"space",text:" "}:t)}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/;function expandSuffixParts(n){let t=[""];for(const s of n){const o=[];for(const r of t)for(const f of s)o.push(r+f);t=o}return t.sort((s,o)=>o.length-s.length||s.localeCompare(o))}function extractSuffix(n,t){const s=t||{};if(Array.isArray(s.suffixParts)&&s.suffixParts.length>0){const f=s._expanded||(s._expanded=expandSuffixParts(s.suffixParts));for(const e of f)if(n.length>e.length+1&&n.endsWith("_"+e)){const i=[];let u=e;for(const c of s.suffixParts){const a=c.find(l=>u.startsWith(l));if(a===void 0){i.length=0;break}i.push(a),u=u.slice(a.length)}return{base:n.slice(0,-(e.length+1)),suffix:e,parts:i.length?i:void 0}}return null}if(Array.isArray(s.suffixList)&&s.suffixList.length>0){let f=null;for(const e of s.suffixList)n.length>e.length+1&&n.endsWith("_"+e)&&(f===null||e.length>f.length)&&(f=e);return f===null?null:{base:n.slice(0,-(f.length+1)),suffix:f}}const o=s.suffixPattern?new RegExp(s.suffixPattern):DEFAULT_SUFFIX_RE,r=String(n).match(o);return r?{base:r[1],suffix:r[2]}:null}const DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001";function suffixWords(n,t){const s=String(n||"");if(s.length<2)return[];const o=[s];if(Array.isArray(t)&&t.length>0)for(const e of t)String(e).length>=2&&o.push(String(e));else for(const e of s.indexOf("_")>0?s.split("_"):[s])e.length<2||(e!==s&&o.push(e),e.length>=4&&e.length%2===0&&o.push(e.slice(0,e.length/2),e.slice(e.length/2)));const r={},f=[];for(const e of o){const i=e.toLowerCase();r[i]||(r[i]=1,f.push(i))}return f}function buildLiteralMap(n){if(!Array.isArray(n)||n.length===0)return null;const t=typeof n[0]=="string"?[n]:n,s={};let o=0;for(let r=0;r<t.length;r++){if(!Array.isArray(t[r]))continue;const f=LITERAL_MARK+(r+1)+LITERAL_MARK;for(const e of t[r]){const i=String(e==null?"":e).toLowerCase();i&&(s[i]=f,o++)}}return o>0?s:null}function parseEquivalents(n){const t=n||{},s=t.equivalentLiterals;if(Array.isArray(s)){let o=!1;const r=[],f=[];for(const e of s)Array.isArray(e)?r.push(e):String(e).toLowerCase()==="suffix"?o=!0:e!=null&&f.push(e);return r.length===0&&f.length>0&&r.push(f),{useWords:o,groups:r.length>0?r:null}}return{useWords:t.literalSuffixWords!==!1,groups:Array.isArray(t.literalGroups)?t.literalGroups:null}}function maskTokens(n,t,s,o){const r=String(t||""),f=r.length>=2,e=parseEquivalents(o),i=f&&e.useWords?suffixWords(r,s):[],u=buildLiteralMap(e.groups);return!f&&i.length===0&&!u?n:n.map(c=>{if(c.kind==="space")return c;let a=c.text;if(f&&a.indexOf(r)>=0&&(a=a.split(r).join(SUFFIX_MARK)),i.length>0||u){const l=c.kind==="string"&&a.length>=2?a.slice(1,-1):c.kind==="number"?a:null;if(l){const h=l.toLowerCase(),p=i.indexOf(h)>=0?SUFFIX_MARK:u&&u[h];p&&(a=c.kind==="string"?a[0]+p+a[0]:p)}}return a===c.text?c:{kind:c.kind,text:a}})}function alphaMapDetail(n,t,s){if(n.length!==t.length)return{ok:!1,reason:"length",aLen:n.length,bLen:t.length};const o=new Set(s&&s.substitutable||DEFAULT_SUBSTITUTABLE),r=new Map,f=new Map;for(let e=0;e<n.length;e++){const i=n[e],u=t[e],c=a=>({ok:!1,reason:a,index:e,kind:i.kind,otherKind:u.kind,aText:i.text,bText:u.text});if(i.kind!==u.kind)return c("kind");if(i.text!==u.text){if(!o.has(i.kind))return c("not-substitutable");if(r.has(i.text)&&r.get(i.text)!==u.text)return c("inconsistent");if(f.has(u.text)&&f.get(u.text)!==i.text)return c("not-injective");r.set(i.text,u.text),f.set(u.text,i.text)}}return{ok:!0,fwd:r,rev:f}}function parameterize(n,t){const s=t.tokens.length,o=new Map,r=[],f=[],e=(i,u)=>i.diff.has(u)?i.diff.get(u):t.raw[u].text;for(let i=0;i<s;i++){if(t.tokens[i].kind==="space"){f.push(t.raw[i].text);continue}const u=n.map(l=>e(l,i));let c=!0;for(let l=1;l<u.length;l++)if(u[l]!==u[0]){c=!1;break}if(c){f.push(u[0]);continue}const a=JSON.stringify(u);if(!o.has(a)){const l="P"+(r.length+1);o.set(a,l);const h={};n.forEach((p,d)=>{h[p.suffix]=u[d]}),r.push({name:l,kind:t.raw[i].kind,values:h})}f.push("{{"+o.get(a)+"}}")}return{sql:f.join(""),params:r}}function groupByLogic(n,t){const s=!(t&&t.stripOptions===!1),o=!(t&&t.suffixAware===!1),r=[];for(const e of n){let i=tokenizeSql(e.ddl);s&&(i=stripOptionsClause(i)),i=markEntities(i);const u=maskTokens(normalizeSpace(i),o?e.suffix:null,e.parts,t),c={viewName:e.viewName,suffix:e.suffix,parts:e.parts,ddl:e.ddl};let a=null;for(const l of r)if(alphaMapDetail(l.rep.tokens,u,t).ok){a=l;break}if(a){const l=new Map;for(let h=0;h<i.length;h++)i[h].text!==a.rep.raw[h].text&&l.set(h,i[h].text);a.members.push(x(g({},c),{diff:l}))}else{const l=x(g({},c),{raw:i,tokens:u});r.push({rep:l,members:[x(g({},c),{diff:new Map})]})}}r.sort((e,i)=>i.members.length-e.members.length||String(e.members[0].suffix).localeCompare(String(i.members[0].suffix)));const f=r.map(e=>e.rep);return r.map((e,i)=>{const u=e.members.slice().sort((l,h)=>String(l.suffix).localeCompare(String(h.suffix))),c=parameterize(u,e.rep),a=f.map((l,h)=>h===i?null:{vs:l.suffix,detail:alphaMapDetail(l.tokens,e.rep.tokens,t)});return{suffixes:u.map(l=>l.suffix),members:u.map(l=>({viewName:l.viewName,suffix:l.suffix,parts:l.parts,ddl:l.ddl})),sql:c.sql,params:c.params,missBy:a,miss:a[0]}})}function analyze(n,t){const s=!(t&&t.includeUnmatched===!1),o=new Map,r=[];for(const e of n){const i=extractSuffix(e.view_name,t);if(!i){r.push(e);continue}o.has(i.base)||o.set(i.base,[]),o.get(i.base).push({viewName:e.view_name,suffix:i.suffix,parts:i.parts,ddl:e.ddl})}const f=[];for(const[e,i]of o){const u=groupByLogic(i,t);f.push({base:e,viewCount:i.length,groupCount:u.length,groups:u})}if(s)for(const e of r){const i=[{viewName:e.view_name,suffix:null,parts:null,ddl:e.ddl}];f.push({base:e.view_name,viewCount:1,groupCount:1,groups:groupByLogic(i,t),unmatched:!0})}return f.sort((e,i)=>i.groupCount-e.groupCount||e.base.localeCompare(i.base)),{bases:f,unmatched:r}}function __opts(n){if(!n)return{};try{return JSON.parse(n)||{}}catch(t){return{}}}function __notice(n){return'<div class="vg-notice">'+String(n).replace(/[<>&]/g,"")+"</div>"}function __trimBase(n){for(var t=[],s=0;s<n.groups.length;s++){for(var o=n.groups[s],r=[],f=0;f<o.members.length;f++)r.push({viewName:o.members[f].viewName});t.push({suffixes:o.suffixes,members:r,sql:o.sql,params:o.params,miss:o.miss,missBy:o.missBy})}return{base:n.base,viewCount:n.viewCount,groupCount:n.groupCount,unmatched:n.unmatched,groups:t}}function __label(n){for(var t=[],s=0;s<n.suffixes.length;s++)t.push(n.suffixes[s]||n.members[s]&&n.members[s].viewName||"(suffix \u306A\u3057)");return t.join(", ")}function __payload(n){return{viewCount:0,groupCount:0,groupLabels:[],groupSizes:[],suffixes:[],unmatchedCount:0,bases:[],lead:n||"",tail:""}}function __run(n,t){var s=__opts(t);if(!n||n.length===0)return JSON.stringify(__payload("View \u304C\u6E21\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"));for(var o=[],r=0;r<n.length;r++)n[r]&&o.push({view_name:n[r].view_name,ddl:n[r].ddl});var f=analyze(o,s);if(f.bases.length===0){var e=__payload(o.length+" \u4EF6\u3059\u3079\u3066 suffix \u3092\u8A8D\u8B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002suffixParts / suffixList / suffixPattern \u306E\u6307\u5B9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return e.unmatchedCount=f.unmatched.length,JSON.stringify(e)}for(var i=__payload(""),u=0;u<f.bases.length;u++){var c=f.bases[u];i.bases.push(__trimBase(c)),i.viewCount+=c.viewCount,i.groupCount+=c.groupCount;for(var a=0;a<c.groups.length;a++){var l=c.groups[a];i.groupLabels.push(__label(l)),i.groupSizes.push(l.members.length);for(var h=0;h<l.suffixes.length;h++)i.suffixes.push(l.suffixes[h]||l.members[h].viewName)}}return i.suffixes.sort(),i.unmatchedCount=f.unmatched.length,f.unmatched.length>0&&s.includeUnmatched===!1&&(i.tail="suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u304C "+f.unmatched.length+" \u4EF6\u3042\u308A\u307E\u3059\u3002"),JSON.stringify(i)}return __run(views,options_json);

""";

DECLARE js_render STRING DEFAULT r"""
var x=Object.defineProperty;var u=Object.getOwnPropertySymbols;var b=Object.prototype.hasOwnProperty,v=Object.prototype.propertyIsEnumerable;var h=(e,n,t)=>n in e?x(e,n,{enumerable:!0,configurable:!0,writable:!0,value:t}):e[n]=t,f=(e,n)=>{for(var t in n||(n={}))b.call(n,t)&&h(e,t,n[t]);if(u)for(var t of u(n))v.call(n,t)&&h(e,t,n[t]);return e};const MAX_TABS=12,MAX_SQL_TABS=128,MAX_DESC_TABS=16,MAX_LABEL_TABS=8,OUTER_TABS=["note","\u30AB\u30E9\u30E0\u5B9A\u7FA9","\u53C2\u7167\u95A2\u4FC2","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","SQL"],MAX_OUTER_TABS=8,NOTE_MARK="<!--VG_NOTE-->",CSS_GEN=10;function groupRule(e,n,t){const r=[];for(let o=1;o<=e;o++){const s=n(o);if(Array.isArray(s))for(const i of s)r.push(i);else r.push(s)}return r.join(",")+"{"+t+"}"}function hashId(e){let n=2166136261;for(let t=0;t<String(e).length;t++)n^=String(e).charCodeAt(t),n=Math.imul(n,16777619)>>>0;return n.toString(36)}const label=e=>e.suffixes.map((n,t)=>n||e.members[t]&&e.members[t].viewName||"(suffix \u306A\u3057)").join(", ");function badge(e,n,t){return`<span class="vg-badge" style="color:${n};background:${t}">${esc(e)}</span>`}function header(e,n,t,r,o){const s=t>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${n} View`,"#57606A","#EAEEF2")+badge(`${t} \u30B0\u30EB\u30FC\u30D7`,s?"#9A6700":"#1A7F37",s?"#FFF8C5":"#DAFBE1")+(r?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+(o?badge("\u30E9\u30D9\u30EB\u4E0D\u4E00\u81F4","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e;function diffLines(e,n){const t=e.length,r=n.length,o=[];for(let a=0;a<=t;a++)o.push(new Int32Array(r+1));for(let a=t-1;a>=0;a--)for(let l=r-1;l>=0;l--)o[a][l]=e[a]===n[l]?o[a+1][l+1]+1:Math.max(o[a+1][l],o[a][l+1]);const s=[];let i=0,d=0;for(;i<t&&d<r;)e[i]===n[d]?(s.push({type:"equal",aIndex:i,bIndex:d,text:e[i]}),i++,d++):o[i+1][d]>=o[i][d+1]?(s.push({type:"del",aIndex:i,text:e[i]}),i++):(s.push({type:"add",bIndex:d,text:n[d]}),d++);for(;i<t;)s.push({type:"del",aIndex:i,text:e[i]}),i++;for(;d<r;)s.push({type:"add",bIndex:d,text:n[d]}),d++;return s}function lcsMatchFlags(e,n){const t=e.length,r=n.length,o=[];for(let a=0;a<=t;a++)o.push(new Int32Array(r+1));for(let a=t-1;a>=0;a--)for(let l=r-1;l>=0;l--)o[a][l]=e[a]===n[l]?o[a+1][l+1]+1:Math.max(o[a+1][l],o[a][l+1]);const s=new Array(t).fill(!1);let i=0,d=0;for(;i<t&&d<r;)e[i]===n[d]?(s[i]=!0,i++,d++):o[i+1][d]>=o[i][d+1]?i++:d++;return s}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const n=[];for(const t of e){const r=n[n.length-1];r&&r.hi===t.hi?r.text+=t.text:n.push({text:t.text,hi:t.hi})}return n}function segDiff(e,n){const t=e.length,r=n.length,o=[];for(let l=0;l<=t;l++)o.push(new Int32Array(r+1));for(let l=t-1;l>=0;l--)for(let p=r-1;p>=0;p--)o[l][p]=e[l]===n[p]?o[l+1][p+1]+1:Math.max(o[l+1][p],o[l][p+1]);const s=[],i=[];let d=0,a=0;for(;d<t&&a<r;)e[d]===n[a]?(s.push({text:e[d],hi:!1}),i.push({text:n[a],hi:!1}),d++,a++):o[d+1][a]>=o[d][a+1]?(s.push({text:e[d],hi:!0}),d++):(i.push({text:n[a],hi:!0}),a++);for(;d<t;)s.push({text:e[d],hi:!0}),d++;for(;a<r;)i.push({text:n[a],hi:!0}),a++;return{oldSegs:mergeSegs(s),newSegs:mergeSegs(i)}}function wordDiff(e,n){return segDiff(tokenize(e),tokenize(n))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(a=>[{text:String(a),hi:!1}]);if(e.length===2){const a=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[a.oldSegs,a.newSegs]}const n=tokenizeName(e[0]),t=tokenizeName(e[1]),r=tokenizeName(e[2]),o=segDiff(n,t).newSegs,s=segDiff(n,r).newSegs,i=new Array(n.length).fill(!0);for(const a of[t,r]){const l=lcsMatchFlags(n,a);for(let p=0;p<n.length;p++)i[p]=i[p]&&l[p]}return[mergeSegs(n.map((a,l)=>({text:a,hi:!i[l]}))),o,s]}function build2Way(e,n){const t=diffLines(e,n),r=[];let o=0;for(;o<t.length;){if(t[o].type==="equal"){const a=t[o];r.push({type:"equal",left:{num:a.aIndex+1,segs:[{text:a.text,hi:!1}],kind:"plain"},right:{num:a.bIndex+1,segs:[{text:a.text,hi:!1}],kind:"plain"}}),o++;continue}const s=[];for(;o<t.length&&t[o].type==="del";)s.push(t[o++]);const i=[];for(;o<t.length&&t[o].type==="add";)i.push(t[o++]);const d=Math.max(s.length,i.length);for(let a=0;a<d;a++){const l=s[a],p=i[a];if(l&&p){const c=wordDiff(l.text,p.text);r.push({type:"mod",left:{num:l.aIndex+1,segs:c.oldSegs,kind:"del"},right:{num:p.bIndex+1,segs:c.newSegs,kind:"add"}})}else l?r.push({type:"del",left:{num:l.aIndex+1,segs:[{text:l.text,hi:!1}],kind:"del"},right:null}):r.push({type:"add",left:null,right:{num:p.bIndex+1,segs:[{text:p.text,hi:!1}],kind:"add"}})}}return r}function splitLines(e){const n=String(e).split(/\r\n|\r|\n/);return n.length>1&&n[n.length-1]===""&&n.pop(),n}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=f({},DEFAULTS.T),PANES,S=f({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(t=>t+t).join(""));const n=parseInt(e,16);return[n>>16&255,n>>8&255,n&255]}function toHex(e,n,t){const r=o=>("0"+Math.round(Math.max(0,Math.min(255,o))).toString(16)).slice(-2);return"#"+r(e)+r(n)+r(t)}function mixWhite(e,n){const[t,r,o]=hexToRgb(e),s=i=>255+(i-255)*n;return toHex(s(t),s(r),s(o))}function darken(e,n){const[t,r,o]=hexToRgb(e),s=i=>i*(1-n);return toHex(s(t),s(r),s(o))}function buildPane(e,n,t){return{bg:mixWhite(e,n),hi:mixWhite(e,t),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=f({},DEFAULTS.T),S=f({},DEFAULTS.S);const n=f({},DEFAULTS.paneColors);let t=DEFAULTS.lineOpacity,r=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const o=e.colors||{};HEX.test(o.baseColor||"")&&(n.base=o.baseColor),HEX.test(o.afterColor||"")&&(n.after=o.afterColor),HEX.test(o.refColor||"")&&(n.ref=o.refColor),isNum(e.diffLineOpacity)&&(t=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(r=e.diffCharOpacity);const s=e.syntax||{};s.keyword&&(S.keyword=s.keyword),s.literal&&(S.literal=s.literal),s.comment&&(S.comment=s.comment)}PANES={base:buildPane(n.base,t,r),after:buildPane(n.after,t,r),ref:buildPane(n.ref,t,r)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function esc(e){return String(e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function escAttr(e){return esc(e).replace(/"/g,"&quot;")}const PARAM_HTML_RE=/\{(?:<[^>]+>)*\{(?:<[^>]+>)*(P\d+)(?:<[^>]+>)*\}(?:<[^>]+>)*\}/g;function withTips(e,n,t){if(!n)return e;const r=t?"vg-ph vg-phr":"vg-ph";return e.replace(PARAM_HTML_RE,(o,s)=>{const i=n[s];return i?`<span class="${r}" data-tip="${escAttr(i)}">${o}</span>`:o})}function sqlHighlight(e){const n=e.length;let t=0,r="";const o=(p,c,g)=>`<span style="color:${p};${g?"font-style:italic;":""}">${esc(c)}</span>`,s=p=>p===" "||p==="	",i=p=>p>="0"&&p<="9",d=p=>/[A-Za-z_]/.test(p),a=p=>/[A-Za-z0-9_]/.test(p),l=p=>"=<>!+-*/%|,.();:".indexOf(p)>=0;for(;t<n;){const p=e[t];if(s(p)){let c=t+1;for(;c<n&&s(e[c]);)c++;r+=esc(e.slice(t,c)),t=c;continue}if(p==="-"&&e[t+1]==="-"){r+=o(S.comment,e.slice(t),!0);break}if(p==="'"){let c=t+1;for(;c<n;){if(e[c]==="'"){if(e[c+1]==="'"){c+=2;continue}c++;break}c++}r+=o(S.literal,e.slice(t,c)),t=c;continue}if(i(p)){let c=t+1;for(;c<n&&(i(e[c])||e[c]===".");)c++;r+=o(S.literal,e.slice(t,c)),t=c;continue}if(d(p)){let c=t+1;for(;c<n&&a(e[c]);)c++;const g=e.slice(t,c);SQL_KEYWORDS.has(g.toUpperCase())?r+=o(S.keyword,g):r+=esc(g),t=c;continue}r+=esc(p),t++}return r}function renderSegs(e,n,t,r){if(!e||!e.length)return"&nbsp;";let o="";for(const s of e){const i=sqlHighlight(s.text);o+=s.hi?`<span style="background:${n};border-radius:2px;">${i}</span>`:i}return o===""?"&nbsp;":withTips(o,t,r)}function numTd(e,n,t){const r=t?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${n.numBg};border-right:1px solid ${T.numBorder};${r}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,n){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,n,t){let r=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(r+=`background:${t.bg};border-left:2px solid ${t.bar};`),`<td style="${r}">${n||"&nbsp;"}</td>`}function hatchTd(e,n){const t=n?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${t}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${t}${T.hatch}">&nbsp;</td>`}function labelHtml(e,n){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(t=>t.hi?`<span style="background:${n.hi};border-radius:2px;">${esc(t.text)}</span>`:esc(t.text)).join("")}function th(e,n,t,r,o){const s=o?`border-left:1px solid ${T.border};`:"",i=t?`&nbsp;<span style="color:${r.headText};font-weight:400;">(${esc(t)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${r.headBg};border-bottom:2px solid ${r.bar};${s}padding:7px 12px;">${labelHtml(n,r)}${i}</th>`}function wrapTable(e,n,t,r){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:${r?"visible":"hidden"};font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${n}</tr></thead>
    <tbody>
${t}    </tbody>
  </table>
</div>
`}function renderFragment1(e,n,t,r,o){configure(r);const s='<colgroup><col style="width:40px"><col></colgroup>',i=th(2,e,n,PANES.base,!1);let d="";for(let a=0;a<t.length;a++)d+=`      <tr>${numTd(a+1,PANES.base,!1)}${codeTd("same",withTips(sqlHighlight(t[a]),o),PANES.base)}</tr>
`;return wrapTable(s,i,d,!!o)}function renderFragment2(e,n,t,r,o){configure(r);const s='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',i=nameDiff([e,n]),d=th(3,i[0],"before",PANES.base,!1)+th(3,i[1],"after",PANES.after,!0);let a="";for(const l of t){const p=l.left,c=l.right;let g="";p?g+=numTd(p.num,PANES.base,!1)+markTd(p.kind==="del"?"del":"blank",PANES.base)+codeTd(p.kind,renderSegs(p.segs,PANES.base.hi,o&&o.left),PANES.base):g+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),c?g+=numTd(c.num,PANES.after,!0)+markTd(c.kind==="add"?"add":"blank",PANES.after)+codeTd(c.kind,renderSegs(c.segs,PANES.after.hi,o&&o.right,!0),PANES.after):g+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),a+=`      <tr>${g}</tr>
`}return wrapTable(s,d,a,!!o)}function relabelPanes(e,n){let t=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(r,o,s)=>{const i=n[t++];return i==null?r:o+esc(i)+s})}const paneSub=e=>`${e.members.length} View`,REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u3067\u304D\u306A\u3044\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u5217\u540D\u30FB\u5225\u540D\u30FBCTE \u540D\u30FB\u4E88\u7D04\u8A9E\u306A\u3069\u3002\u7F6E\u63DB\u3057\u3066\u3088\u3044\u306E\u306F FROM / JOIN \u306E\u5B9F\u4F53\u540D\u3068\u5024\u3060\u3051\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e,n,t){const r=a=>String(a==null?"":a).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),o=a=>a.missBy?a.missBy[n]:a.miss,s=e.filter(a=>o(a)).map(a=>{const l=o(a).detail,p=l.reason==="length"?`${l.aLen} \u5BFE ${l.bLen}`:`<code class="vg-mcode">${esc(r(l.aText))}</code> \u2194 <code class="vg-mcode">${esc(r(l.bText))}</code><span class="vg-mkind">${esc(kindText(l.kind))}</span>`;return`<tr><th class="vg-mname">${esc(label(a))}</th><td class="vg-mvs">vs ${esc(t)}</td><td class="vg-mreason">${esc(REASON_TEXT[l.reason]||l.reason)}<br>${p}</td></tr>`}).join("");return s?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(a=>o(a)&&o(a).detail.reason==="not-substitutable"&&(o(a).detail.kind==="string"||o(a).detail.kind==="number"))?'<div class="vg-mhint">\u5024\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u3067\u306F\u5024\u306F\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u3066\u540C\u3058\u30B0\u30EB\u30FC\u30D7\u306B\u3059\u308B\u306E\u3067\u3001<code class="vg-mcode">substitutable</code> \u3092\u7D5E\u3063\u305F\u8A2D\u5B9A\u306B\u306A\u3063\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u306B\u623B\u3059\u306A\u3089 options_json \u304B\u3089 <code class="vg-mcode">"substitutable"</code> \u3092\u5916\u3057\u307E\u3059\u3002<br>\u7D5E\u3063\u305F\u307E\u307E\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>':""}<div class="vg-pblock"><table class="vg-ptable">${s}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(t=>{if(!t.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const r=t.params.map(o=>{const s=Object.entries(o.values).map(([d,a])=>`<div class="vg-pv"><span class="vg-psuf">${esc(d)}</span>${esc(a)}</div>`).join(""),i=`<span class="vg-mkind">${esc(kindText(o.kind))}</span>`;return`<tr><th class="vg-pname">${esc(o.name)}</th><td class="vg-pvals">${i}${s}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><table class="vg-ptable">${r}</table></div>`}).join("")}</details>`}function paramTips(e){const n={};for(const t of e.params)n[t.name]=`${t.name}: ${kindText(t.kind)}
`+Object.entries(t.values).map(([r,o])=>`${r||"(suffix \u306A\u3057)"} = ${o}`).join(`
`);return n}function pair(e,n,t){return relabelPanes(renderFragment2(label(e),label(n),build2Way(splitLines(e.sql),splitLines(n.sql)),t,{left:paramTips(e),right:paramTips(n)}),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(n)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,n,t,r){const o=e[n],s=e.filter((c,g)=>g!==n),i=s.slice(0,12),d=i.map((c,g)=>`<input class="vg-r vg-r${g+1}" type="radio" name="${r}" id="${r}-${g+1}"${g===0?" checked":""}>`).join(""),a=baseTab(o)+i.map((c,g)=>`<label class="vg-tab vg-t${g+1}" for="${r}-${g+1}">${esc(label(c))}<span class="vg-tabn">${c.members.length}</span></label>`).join(""),l=i.length?i.map((c,g)=>`<div class="vg-panel vg-p${g+1}">${pair(o,c,t)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(o),paneSub(o),splitLines(o.sql),t,paramTips(o))}</div>`;return(s.length>i.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D 12 \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${s.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${d}<div class="vg-tablist">${a}</div><div class="vg-panels">${l}</div></div>`}function refPanel(e,n,t){const r=e.groups,o="vgt"+hashId(e.base+"|"+r.map(label).join("|")+"|"+n);return tabs(r,n,t,o)+missTable(r,n,label(r[n]))}function refCaption(e,n,t){const r=e.groups,o=Number((t||{}).maxRefRows)||0,s=o>0&&r.length>o?notice(`\u57FA\u6E96\u306B\u3067\u304D\u308B\u306E\u306F\u5148\u982D ${o} \u30B0\u30EB\u30FC\u30D7\u307E\u3067\u306B\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${r.length} \u4EF6\uFF09\u3002\u3053\u306E base \u306F\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3059\u304E\u306A\u3044\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002`):"";return`<div class="vg-refhead"><span class="vg-blabel">\u57FA\u6E96\u30B0\u30EB\u30FC\u30D7</span><span class="vg-refname">${esc(label(r[n]))}<span class="vg-tabn">${r[n].members.length}</span></span><span class="vg-refnote">\uFF08\u30EC\u30DD\u30FC\u30C8\u306E\u300C\u57FA\u6E96\u300D\u3067\u5207\u308A\u66FF\u3048\uFF09</span></div>`+s}function renderBase(e,n){const t=n||{},r=e.groups,o=r.length,s=Math.max(0,Math.min(o-1,Math.floor(Number(t.refIndex)||0)));let i;return o===0?i=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):o===1?i=notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`)+refPanel(e,0,t):i=refCaption(e,s,t)+refPanel(e,s,t),'<div class="vg-root">'+header(e.base,e.viewCount,o,e.unmatched)+i+paramsTable(r)+"</div>"}function chromeCss(){const e=[".vg-cssgen10{display:none}",".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid #D0D7DE;background:#F6F8FA;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font-weight:600;font-size:12px;line-height:1.8;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font-weight:600;font-size:12px;line-height:1.6;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}",".vg-ph{position:relative;margin:0 -2px;padding:0 2px;border-radius:3px;background:#F1E8FD;color:#6639BA;font-weight:700;box-shadow:inset 0 0 0 1px #CDB6F2;cursor:help}",".vg-ph:hover{background:#E4D3FB}",".vg-ph::after{content:attr(data-tip);display:none;position:absolute;z-index:20;left:0;top:calc(100% + 5px);width:max-content;max-width:340px;padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}",".vg-ph:hover::after{display:block}",".vg-ph.vg-phr::after{left:auto;right:0}",".vg-refhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px;padding:0 0 8px;border-bottom:1px solid #D0D7DE}",".vg-blabel{color:#57606A;font-size:12px;font-weight:600;margin-right:2px}",".vg-refname{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-refnote{color:#57606A;font-size:11px}",".vg-or{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-outer{max-height:min(100vh,2000px);overflow:auto;--vg-bar:75px}",".vg-otablist,.vg-ohead{display:flex;flex-wrap:wrap;align-items:center;gap:6px;position:sticky;top:0;z-index:5;background:#fff;margin:0 0 10px;padding:8px 0;box-shadow:0 1px 0 #EAEEF2}",".vg-otablist>.vg-header,.vg-ohead>.vg-header{flex:0 0 100%;margin:0}",".vg-ohead>.vg-otablist{position:static;padding:0;margin:0;box-shadow:none;flex:0 0 100%}",".vg-opanel .vg-header{display:none}",".vg-otab{display:inline-flex;align-items:center;padding:5px 16px;border:1px solid #D0D7DE;border-radius:16px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px}",".vg-otab:hover{background:#EAEEF2;color:#24292F}",".vg-opanel{display:none}",".vg-erdblock{margin:0 0 28px;border:1px solid #D0D7DE;border-radius:6px;background:#fff}",".vg-erdblock:last-child{margin-bottom:0}",".vg-erdhead{display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid #EAEEF2;background:#F6F8FA;border-radius:6px 6px 0 0}",".vg-erdname{font-weight:600;color:#24292F;font-size:12px}",".vg-erdbox{overflow-x:auto;padding:6px 10px 10px}",".vg-legend{display:flex;flex-wrap:wrap;gap:14px;margin:8px 0 10px;color:#57606A;font-size:11px}",".vg-lg{display:inline-flex;align-items:center;gap:5px}",".vg-lgm{display:inline-block;width:10px;height:10px;border-radius:2px;border:1px solid #8C96A0}",".vg-lgt{background:#C9A227;border-color:#8C6D3F}",".vg-lgc{background:#4E8FBF;border-color:#3F6D8C}",".vg-lgo{background:#8250DF;border-color:#6D3F8C}",".vg-lgd{display:inline-block;width:18px;border-top:1.5px dashed #8C96A0}"],n=[".vg-otablist > ",".vg-ohead > .vg-otablist > "];return e.push(groupRule(8,t=>`.vg-or${t}:checked ~ .vg-opanels > .vg-op${t}`,"display:block")),e.push(groupRule(8,t=>n.map(r=>`.vg-or${t}:checked ~ ${r}.vg-ot${t}`),"background:#24292F;border-color:#24292F;color:#fff")),e.push(groupRule(12,t=>`.vg-r${t}:checked ~ .vg-panels > .vg-p${t}`,"display:block")),e.push(groupRule(12,t=>`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t}`,"background:#f0f4ea;border-color:#c4d2ac;color:#24292F")),e.push(groupRule(12,t=>`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t} .vg-tabn`,"background:#dfe7d2;color:#58683e")),e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(n){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var n=2166136261,t=0;t<e.length;t++)n^=e.charCodeAt(t),n=Math.imul(n,16777619)>>>0;return"d"+n.toString(36)}function __split(e){var n={},t=e.replace(/ style="([^"]*)"/g,function(r,o){var s=__hashClass(o);return n[s]=o,' class="'+s+'"'});return{markup:t,rules:n}}function __rulesToCss(e){for(var n=Object.keys(e).sort(),t=[],r=0;r<n.length;r++)t.push("."+n[r]+"{"+e[n[r]]+"}");return t.join(`
`)}function __applyMode(e,n){if(n==="class")return __split(e).markup;if(n==="embed"){var t=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(t.rules)+`
</style>
`+t.markup}return e}function __run(e,n,t){var r=__opts(n),o;try{o=JSON.parse(e)}catch(a){o=null}if(!o)return __notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002");t!=null&&(r.refIndex=Math.floor(Number(t)));for(var s=o.lead?__notice(o.lead):"",i=o.bases||[],d=0;d<i.length;d++)s+=renderBase(i[d],r);return o.tail&&(s+=__notice(o.tail)),__applyMode(s,r.mode||"inline")}return __run(analysis_json,options_json,ref_index);

""";

DECLARE js_erd STRING DEFAULT r"""
var B=Object.defineProperty,D=Object.defineProperties;var G=Object.getOwnPropertyDescriptors;var $=Object.getOwnPropertySymbols;var W=Object.prototype.hasOwnProperty,j=Object.prototype.propertyIsEnumerable;var _=(e,t,n)=>t in e?B(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,C=(e,t)=>{for(var n in t||(t={}))W.call(t,n)&&_(e,n,t[n]);if($)for(var n of $(t))j.call(t,n)&&_(e,n,t[n]);return e},L=(e,t)=>D(e,G(t));const MAX_TABS=12,MAX_SQL_TABS=128,MAX_DESC_TABS=16,MAX_LABEL_TABS=8,OUTER_TABS=["note","\u30AB\u30E9\u30E0\u5B9A\u7FA9","\u53C2\u7167\u95A2\u4FC2","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","SQL"],MAX_OUTER_TABS=8,NOTE_MARK="<!--VG_NOTE-->",CSS_GEN=10;function groupRule(e,t,n){const s=[];for(let o=1;o<=e;o++){const i=t(o);if(Array.isArray(i))for(const c of i)s.push(c);else s.push(i)}return s.join(",")+"{"+n+"}"}function esc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(e){let t=2166136261;for(let n=0;n<String(e).length;n++)t^=String(e).charCodeAt(n),t=Math.imul(t,16777619)>>>0;return t.toString(36)}const label=e=>e.suffixes.map((t,n)=>t||e.members[n]&&e.members[n].viewName||"(suffix \u306A\u3057)").join(", ");function badge(e,t,n){return`<span class="vg-badge" style="color:${t};background:${n}">${esc(e)}</span>`}function header(e,t,n,s,o){const i=n>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${t} View`,"#57606A","#EAEEF2")+badge(`${n} \u30B0\u30EB\u30FC\u30D7`,i?"#9A6700":"#1A7F37",i?"#FFF8C5":"#DAFBE1")+(s?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+(o?badge("\u30E9\u30D9\u30EB\u4E0D\u4E00\u81F4","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e,DQ="\\u0022",DQ3=DQ+DQ+DQ,TOKEN_RE=new RegExp(["(`[^`]*`)","([rbRB]{1,2}(?:'''[\\s\\S]*?'''|"+DQ3+"[\\s\\S]*?"+DQ3+"|'[^']*'|"+DQ+"[^"+DQ+"]*"+DQ+"))","('''[\\s\\S]*?''')","("+DQ3+"[\\s\\S]*?"+DQ3+")","('(?:\\\\.|''|[^'\\\\])*')","("+DQ+"(?:\\\\.|"+DQ+DQ+"|[^"+DQ+"\\\\])*"+DQ+")","(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(0[xX][0-9a-fA-F]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][+-]?\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],n=String(e==null?"":e);let s;for(TOKEN_RE.lastIndex=0;(s=TOKEN_RE.exec(n))!==null;){let o;s[1]?o="quoted":s[2]||s[3]||s[4]||s[5]||s[6]?o="string":s[7]||s[8]?o="comment":s[9]?o="number":s[10]?o=KEYWORDS.has(s[10].toUpperCase())?"keyword":"ident":s[11]?o="space":o="punct",t.push({kind:o,text:s[0]})}return t}function markEntities(e){const t=e.slice(),n=i=>{let c=i+1;for(;c<t.length&&t[c].kind==="space";)c++;return c},s=[];let o=null;for(let i=0;i<t.length;i++){const c=t[i];if(c.kind==="space"||c.kind==="comment")continue;if(c.text==="("){s.push(o),o=null;continue}if(c.text===")"){s.pop(),o=null;continue}const a=c.text.toUpperCase();if(o=c.kind==="keyword"||c.kind==="ident"?a:null,c.kind!=="keyword"||a!=="FROM"&&a!=="JOIN"||s.length>0&&s[s.length-1]==="EXTRACT")continue;let l=n(i);for(;!(l>=t.length);){const u=t[l];if(u.kind==="quoted")t[l]={kind:"entity",text:u.text},l=n(l);else if(u.kind==="ident"){const d=[];let p=l;for(;;){d.push(p);const k=n(p);if(k<t.length&&t[k].text==="."){const f=n(k);if(f<t.length&&t[f].kind==="ident"){p=f;continue}}break}const g=n(p);if(g<t.length&&t[g].text==="(")break;for(const k of d)t[k]={kind:"entity",text:t[k].text};l=g}else break;if(l<t.length&&t[l].kind==="keyword"&&t[l].text.toUpperCase()==="AS"){const d=n(l);d<t.length&&(t[d].kind==="ident"||t[d].kind==="quoted")&&(l=n(d))}else l<t.length&&t[l].kind==="ident"&&(l=n(l));if(l<t.length&&t[l].text===","){l=n(l);continue}break}}return t}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/,DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001",BOX_W_MIN=130,NAME_CHAR_W=6.65,BOX_H=40,GAP_MIN=78,CHAR_W=6.5,LINE_H=14,GAP_Y=14,PAD=10,kw=e=>e&&e.kind==="keyword"?e.text.toUpperCase():null;function prepare(e){const t=[];let n=0;for(const s of markEntities(tokenizeSql(e)))s.kind==="space"||s.kind==="comment"||(s.text===")"&&n--,t.push({kind:s.kind,text:s.text,depth:n}),s.text==="("&&n++);return t}function cteRanges(e){const t=[];if(!(e[0]&&kw(e[0])==="WITH"))return{ctes:t,mainFrom:0};let n=1;for(;;){const s=e[n],o=e[n+1],i=e[n+2];if(!i||s.kind!=="ident"||kw(o)!=="AS"||i.text!=="(")break;const c=i.depth;let a=n+3;for(;a<e.length&&!(e[a].text===")"&&e[a].depth===c);)a++;if(t.push({name:s.text,from:n+3,to:a,depth:c+1}),n=a+1,e[n]&&e[n].text===","){n++;continue}break}return{ctes:t,mainFrom:n}}const STOP=new Set(["WHERE","GROUP","ORDER","QUALIFY","WINDOW","HAVING","UNION","INTERSECT","EXCEPT","LIMIT","SELECT","JOIN","FROM"]);function skipParen(e,t,n){const s=e[t].depth;let o=t+1;for(;o<n&&!(e[o].text===")"&&e[o].depth===s);)o++;return o+1}function readSource(e,t,n){if(t>=n)return{node:null,next:t};const s=e[t];if(s.text==="(")return{node:{name:"(\u30B5\u30D6\u30AF\u30A8\u30EA)",kind:"subquery"},next:skipParen(e,t,n)};if(kw(s)==="UNNEST"){let o=t+1,i="";if(e[o]&&e[o].text==="("){const c=e[o].depth;let a=o+1;for(;a<n&&!(e[a].text===")"&&e[a].depth===c);)i+=e[a].text,a++;o=a+1}return{node:{name:"UNNEST("+i+")",kind:"unnest"},next:o}}if(s.kind==="entity"||s.kind==="quoted"||s.kind==="ident"){const o=[];let i=t;for(;i<n&&(e[i].kind==="entity"||e[i].kind==="quoted"||e[i].kind==="ident");){if(o.push(e[i].text),i++,i<n&&e[i].text==="."){i++;continue}break}return i<n&&e[i].text==="("?{node:null,next:skipParen(e,i,n)}:{node:{name:o.join("."),kind:"ref"},next:i}}return{node:null,next:t+1}}function skipAlias(e,t,n){if(t<n&&kw(e[t])==="AS"){const s=e[t+1];return s&&(s.kind==="ident"||s.kind==="quoted")?t+2:t+1}return t<n&&e[t].kind==="ident"&&!STOP.has(e[t].text.toUpperCase())?t+1:t}function readOnKeys(e,t,n){const s=[];let o=t;for(;o<n;){const i=kw(e[o]);if(i&&STOP.has(i)||i==="LEFT"||i==="RIGHT"||i==="FULL"||i==="INNER"||i==="CROSS")break;if(e[o].text==="="){const c=(u,d,p)=>u&&d&&p&&d.text==="."?p.text:null,a=c(e[o-3],e[o-2],e[o-1]),l=c(e[o+1],e[o+2],e[o+3]);a&&l&&s.push(a===l?a:a+" = "+l)}o++}return{keys:s,next:o}}function readUsingKeys(e,t,n){const s=[];let o=t;if(e[o]&&e[o].text==="("){const i=e[o].depth;for(o++;o<n&&!(e[o].text===")"&&e[o].depth===i);)e[o].kind==="ident"&&s.push(e[o].text),o++;o++}return{keys:s,next:o}}function joinKind(e,t,n){for(let s=t-1;s>=n&&t-s<=3;s--){const o=kw(e[s]);if(o==="LEFT"||o==="RIGHT"||o==="FULL"||o==="CROSS")return o;if(o==="INNER")return"INNER"}return"INNER"}function scanScope(e,t,n,s){const o=[];for(let i=t;i<n;i++){const c=kw(e[i]);if(c!=="FROM"&&c!=="JOIN")continue;const a=e[i].depth>s,l=c==="JOIN"?joinKind(e,i,t):null;let u=i+1;for(;;){const d=readSource(e,u,n);if(u=d.next,d.node){u=skipAlias(e,u,n);let p=[];if(!a&&u<n&&kw(e[u])==="ON"){const g=readOnKeys(e,u+1,n);p=g.keys,u=g.next}else if(!a&&u<n&&kw(e[u])==="USING"){const g=readUsingKeys(e,u+1,n);p=g.keys,u=g.next}d.node.kind!=="unnest"&&o.push({name:d.node.name,kind:d.node.kind,joinType:l,keys:p,nested:a})}if(u<n&&e[u].text===","&&e[u].depth===e[i].depth){u++;continue}break}i=Math.max(i,u-1)}return o}function buildGraph(e,t){const n=new Map((t||[]).map(f=>[f.name,f])),s=f=>{const x=Object.keys(f.values);return x.length?f.values[x[0]]:null},o=new Map,i=String(e).replace(/\{\{(P\d+)\}\}/g,(f,x)=>{const F=n.get(x);if(!F)return f;const E=s(F);return E==null?f:(o.set(E,F),E)}),c=prepare(i),{ctes:a,mainFrom:l}=cteRanges(c),u=new Set(a.map(f=>f.name)),d=new Map,p=[],g=(f,x)=>{const F=x+":"+f;if(!d.has(F)){const E=[],S=o.get(String(f));if(S)E.push(S);else for(const A of String(f).split(".")){const I=o.get(A);I&&E.indexOf(I)<0&&E.push(I)}d.set(F,{id:F,name:f,label:f,kind:x,params:E})}return F},k=a.map(f=>({id:g(f.name,"cte"),from:f.from,to:f.to,depth:f.depth}));k.push({id:g("(\u6700\u7D42 SELECT)","output"),from:l,to:c.length,depth:0});for(const f of k)for(const x of scanScope(c,f.from,f.to,f.depth)){const F=x.kind==="ref"?u.has(x.name)?"cte":"table":x.kind,E=g(x.name,F);if(E===f.id)continue;const S=p.find(A=>A.from===E&&A.to===f.id);S?(S.keys.length||(S.keys=x.keys),S.joinType||(S.joinType=x.joinType),S.nested=S.nested&&x.nested):p.push({from:E,to:f.id,joinType:x.joinType,keys:x.keys,nested:x.nested})}return{nodes:[...d.values()],edges:p}}function layout(e){const{nodes:t,edges:n}=e,s=new Map(t.map(r=>[r.id,[]])),o=new Map(t.map(r=>[r.id,[]]));for(const r of n)s.has(r.to)&&s.get(r.to).push(r.from),o.has(r.from)&&o.get(r.from).push(r.to);const i=new Map(t.map(r=>[r.id,0]));for(let r=0;r<t.length+1;r++){let h=!1;for(const m of t){const T=s.get(m.id);if(!T.length)continue;const N=Math.max(...T.map(y=>i.get(y)||0))+1;N>i.get(m.id)&&(i.set(m.id,N),h=!0)}if(!h)break}const c=Math.max(0,...t.map(r=>i.get(r.id))),a=new Map(t.map(r=>[r.id,o.get(r.id).length?1/0:c]));for(let r=0;r<t.length+1;r++){let h=!1;for(const m of t){const T=o.get(m.id);if(!T.length)continue;const N=Math.min(...T.map(y=>a.get(y)));N-1<a.get(m.id)&&(a.set(m.id,N-1),h=!0)}if(!h)break}for(const r of t)Number.isFinite(a.get(r.id))||a.set(r.id,c);const l=[];for(const r of t){const h=Math.max(0,a.get(r.id));(l[h]||(l[h]=[])).push(r)}const u=new Map;l.forEach((r,h)=>{r&&(h>0&&r.sort((m,T)=>{const N=y=>{const b=s.get(y.id).filter(M=>u.has(M));return b.length?b.reduce((M,U)=>M+u.get(U),0)/b.length:Number.MAX_SAFE_INTEGER};return N(m)-N(T)}),r.forEach((m,T)=>u.set(m.id,T)))});const d=boxWidth(t),p=new Map;l.forEach((r,h)=>(r||[]).forEach(m=>p.set(m.id,h)));const g=new Array(Math.max(0,l.length-1)).fill(GAP_MIN);for(const r of n){const h=(p.get(r.to)||0)-1;h<0||h>=g.length||(g[h]=Math.max(g[h],linesWidth(edgeLines(r))+22))}const k=[];let f=PAD;for(let r=0;r<l.length;r++)k[r]=f,f+=d+(g[r]||0);const x=new Map;for(const r of n){const h=edgeLines(r);if(!h.length)continue;const m=r.from+"\0"+((p.get(r.to)||0)-1);x.set(m,(x.get(m)||0)+h.length*LINE_H)}const F=new Map;for(const[r,h]of x){const m=r.slice(0,r.indexOf("\0"));F.set(m,Math.max(F.get(m)||0,h))}const E=Math.max(1,...l.map(r=>(r||[]).length)),S=new Array(E).fill(BOX_H);l.forEach(r=>(r||[]).forEach((h,m)=>{S[m]=Math.max(S[m],F.get(h.id)||0)}));const A=[];let I=PAD;for(let r=0;r<E;r++)A[r]=I,I+=S[r]+GAP_Y;const v=[];l.forEach((r,h)=>{(r||[]).forEach((m,T)=>{v.push(L(C({},m),{x:k[h],y:A[T]+(S[T]-BOX_H)/2,w:d,h:BOX_H}))})});const w=new Map(v.map(r=>[r.id,r]));let O=0,R=I-GAP_Y+PAD+6;for(const r of n){const h=w.get(r.from),m=w.get(r.to);if(!h||!m)continue;const T=edgeLines(r);if(!T.length)continue;const N=h.y+h.h/2,y=T.length*LINE_H;O=Math.min(O,N-y/2-PAD),R=Math.max(R,N+y/2+PAD)}return{nodes:v,edges:n.map(r=>L(C({},r),{a:w.get(r.from),b:w.get(r.to)})).filter(r=>r.a&&r.b),gaps:g,colOf:p,y0:O,width:(k[l.length-1]||PAD)+d+PAD,height:R-O}}const KIND={table:{text:"\u5B9F\u30C6\u30FC\u30D6\u30EB",fill:"#FFFFFF",stroke:"#8C6D3F",bar:"#C9A227"},cte:{text:"CTE",fill:"#FFFFFF",stroke:"#3F6D8C",bar:"#4E8FBF"},output:{text:"\u6700\u7D42 SELECT",fill:"#FFFFFF",stroke:"#6D3F8C",bar:"#8250DF"},subquery:{text:"\u30B5\u30D6\u30AF\u30A8\u30EA",fill:"#FFFFFF",stroke:"#6E7781",bar:"#9AA4AE"}},kindOf=e=>KIND[e]||KIND.subquery;function shortName(e){const t=String(e).replace(/`/g,""),n=t.lastIndexOf(".");return n>=0?t.slice(n+1):t}function boxWidth(e){let t=BOX_W_MIN;for(const n of e)t=Math.max(t,shortName(n.label).length*NAME_CHAR_W+24);return t}function fit(e,t){const n=String(e),s=Math.floor((t-24)/NAME_CHAR_W);return n.length>s?n.slice(0,s-1)+"\u2026":n}function edgeLines(e){const t=[];e.joinType&&t.push(e.joinType==="INNER"?"JOIN":e.joinType+" JOIN");for(const n of e.keys||[])t.push(n);return!t.length&&e.nested&&t.push("\u30B5\u30D6\u30AF\u30A8\u30EA"),t}function linesWidth(e){let t=0;for(const n of e)t=Math.max(t,n.length*CHAR_W);return t}function edgeLabel(e){const t=edgeLines(e);return t.length?t.length>1?t[0]+" / "+t.slice(1).join(", "):t[0]:""}function toSvg(e){const t=[];t.push(`<svg viewBox="0 ${(e.y0||0).toFixed(1)} ${e.width} ${e.height}" width="${e.width}" height="${e.height}" role="img" aria-label="\u53C2\u7167\u95A2\u4FC2\u56F3" xmlns="http://www.w3.org/2000/svg">`),t.push('<defs><marker id="vgarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8C96A0"/></marker></defs>');const n=[],s=new Map;for(const o of e.edges){const i=o.a.x+o.a.w,c=o.a.y+o.a.h/2,a=o.b.x,l=o.b.y+o.b.h/2,u=(e.colOf.get(o.to)||0)-1,d=e.gaps&&e.gaps[u]||GAP_MIN,p=a>i?a-d/2:i+d/2,g=`M${i},${c} H${p} V${l} H${a}`,k=edgeLines(o);if(t.push(`<path d="${g}" fill="none" stroke="#8C96A0" stroke-width="1.2" ${o.nested?'stroke-dasharray="4 3" ':""}marker-end="url(#vgarrow)">`+(k.length?`<title>${esc(edgeLabel(o))}</title>`:"")+"</path>"),!k.length)continue;const f=o.from+"\0"+u,x=s.get(f)||{total:0,used:0};x.total+=k.length*LINE_H,s.set(f,x),n.push({x:p,y:c,lines:k,full:edgeLabel(o),key:f})}for(const o of n){const i=s.get(o.key),c=o.lines.length*LINE_H;o.y=o.y-i.total/2+i.used+c/2,i.used+=c}for(const o of n){const i=linesWidth(o.lines)+12,c=o.lines.length*LINE_H;t.push(`<rect x="${(o.x-i/2).toFixed(1)}" y="${(o.y-c/2).toFixed(1)}" width="${i.toFixed(1)}" height="${c}" rx="2" fill="#FFFFFF" opacity="0.92"/>`)}for(const o of n){const i=o.y-o.lines.length*LINE_H/2,c=o.lines.map((a,l)=>`<tspan x="${o.x}" y="${(i+LINE_H*l+11).toFixed(1)}">${esc(a)}</tspan>`).join("");t.push(`<text text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" fill="#57606A"><title>${esc(o.full)}</title>${c}</text>`)}for(const o of e.nodes){const i=kindOf(o.kind),c=o.tipLines||o.params.map(l=>l.name+": "+Object.keys(l.values).map(u=>u+" = "+l.values[u]).join(" / ")),a=o.label+(c.length?`
`+c.join(`
`):"");t.push(`<g><title>${esc(a)}</title>`),t.push(`<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="5" fill="${i.fill}" stroke="${i.stroke}" stroke-width="1"/>`),t.push(`<rect x="${o.x}" y="${o.y}" width="4" height="${o.h}" rx="2" fill="${i.bar}"/>`),t.push(`<text x="${o.x+11}" y="${o.y+17}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="11" font-weight="600" fill="#24292F">${esc(fit(shortName(o.label),o.w))}</text>`),t.push(`<text x="${o.x+11}" y="${o.y+31}" font-family="Roboto,system-ui,sans-serif" font-size="9" fill="#8C96A0">${esc(i.text)}${o.params.length?" \u30FB\u30D1\u30E9\u30E1\u30FC\u30BF":""}</text>`),t.push("</g>")}return t.push("</svg>"),t.join("")}function refBase(e,t){const n=shortName(e);if(!t)return n;const s="_"+t;return n.length>s.length&&n.slice(-s.length)===s?n.slice(0,-s.length):n}function paramBase(e,t){const n=[];for(const s of Object.keys(e.values)){const o=shortName(e.values[s]);n.indexOf(o)<0&&n.push(o)}if(n.length>=2){let s=0;for(;s<n[0].length&&n.every(i=>i[s]===n[0][s]);)s++;const o=n[0].slice(0,s).lastIndexOf("_");if(o>0)return n[0].slice(0,o)}return refBase(n[0],t)}function nodeBase(e,t){const n=shortName(e.name);for(const s of t.params||[])for(const o of Object.keys(s.values))if(shortName(s.values[o])===n)return paramBase(s,(t.suffixes||[])[0]||null);return n}function erdSignature(e){const t=buildGraph(e.sql,e.params),n=new Map(t.nodes.map(s=>[s.id,nodeBase(s,e)+"/"+s.kind]));return JSON.stringify({n:t.nodes.map(s=>n.get(s.id)).sort(),e:t.edges.map(s=>n.get(s.from)+">"+n.get(s.to)+":"+(s.joinType||"")+":"+(s.keys||[]).join("&")).sort()})}function erdGroups(e){const t=new Map,n=[];for(const s of e.groups||[]){const o=erdSignature(s);let i=t.get(o);i||(i={groups:[],suffixes:[],members:[]},t.set(o,i),n.push(i)),i.groups.push(s);for(let c=0;c<(s.suffixes||[]).length;c++)i.suffixes.push(s.suffixes[c]),i.members.push((s.members||[])[c])}return n}function commonStem(e){const t=e.filter(s=>s!=null).map(String);if(!t.length)return"";if(t.every(s=>s===t[0]))return t[0];let n=0;for(;n<t[0].length&&t.every(s=>s[n]===t[0][n]);)n++;return t[0].slice(0,n)+"*"}function groupSvg(e){const t=e.groups||[e],n=buildGraph(t[0].sql,t[0].params);for(const s of n.nodes){const o=nodeBase(s,t[0]),i=[],c=[],a=[];for(const l of t){const u=(l.suffixes||[])[0]||null;for(const d of l.params||[]){const p=Object.keys(d.values);if(paramBase(d,u)===o){a.push(d);for(const g of p)i.push(shortName(d.values[g]));c.push((t.length>1?label(l)+" / ":"")+d.name+": "+p.map(g=>g+" = "+d.values[g]).join(" / "))}}}if(!a.length){s.params=[],s.tipLines=[];continue}s.label=commonStem(i),s.params=a,s.tipLines=c}return toSvg(layout(n))}function erdStack(e){return e.map(t=>`<div class="vg-erdblock"><div class="vg-erdhead"><span class="vg-erdname">${esc(label(t))}</span><span class="vg-tabn">${t.members.length}</span></div><div class="vg-erdbox">${groupSvg(t)}</div></div>`).join("")}function erdLegend(){const e=(t,n)=>`<span class="vg-lg"><span class="vg-lgm ${t}"></span>${esc(n)}</span>`;return'<div class="vg-legend">'+e("vg-lgt","\u5B9F\u30C6\u30FC\u30D6\u30EB")+e("vg-lgc","CTE")+e("vg-lgo","\u6700\u7D42 SELECT")+'<span class="vg-lg"><span class="vg-lgd"></span>\u30B5\u30D6\u30AF\u30A8\u30EA\u7D4C\u7531\u306E\u53C2\u7167</span></div>'}function renderErd(e){if(!e.groups.length)return notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");const t=erdGroups(e),n=t.length<e.groups.length;return notice("FROM / JOIN \u304B\u3089\u8D77\u3053\u3057\u305F\u53C2\u7167\u95A2\u4FC2\u3067\u3059\u3002\u77E2\u5370\u306F\u300C\u8AAD\u3093\u3067\u4F5C\u308B\u300D\u5411\u304D\u3001\u6CE8\u8A18\u306F JOIN \u306E\u7A2E\u5225\u3068\u7D50\u5408\u30AD\u30FC\u3002\u30AB\u30FC\u30C7\u30A3\u30CA\u30EA\u30C6\u30A3\u3068\u4E3B\u30AD\u30FC\u306F SQL \u304B\u3089\u306F\u5206\u304B\u3089\u306A\u3044\u306E\u3067\u63CF\u3044\u3066\u3044\u307E\u305B\u3093\u3002\u3053\u3053\u3067\u306E\u62EC\u308A\u306F\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206\u3068\u306F\u5225\u3067\u3059\u3002\u53C2\u7167\u540D\u306E base \u90E8\u5206\uFF08suffix \u3092\u9664\u3044\u305F\u5B9F\u4F53\u540D\uFF09\u304C\u540C\u3058\u3082\u306E\u306F 1 \u679A\u306B\u307E\u3068\u3081\u3066\u3044\u307E\u3059\u3002"+(n?`\u30ED\u30B8\u30C3\u30AF\u306F ${e.groups.length} \u30B0\u30EB\u30FC\u30D7\u306B\u5272\u308C\u3066\u3044\u307E\u3059\u304C\u3001\u53C2\u7167\u95A2\u4FC2\u306F ${t.length} \u901A\u308A\u3067\u3059\u3002`:"")+"\u540D\u524D\u304C View \u3054\u3068\u306B\u9055\u3046\u7B87\u6240\u306F\u5171\u901A\u90E8\u5206\u3092\u51FA\u3057\u3066\u6B8B\u308A\u3092 * \u306B\u3057\u3066\u3044\u307E\u3059\uFF08\u5B9F\u969B\u306E\u5BFE\u5FDC\u306F\u7BB1\u306B\u30AB\u30FC\u30BD\u30EB\u3092\u4E57\u305B\u308B\u3068\u51FA\u307E\u3059\uFF09\u3002")+erdLegend()+erdStack(t)}function renderErdBase(e){return'<div class="vg-root">'+header(e.base,e.viewCount,e.groups.length,e.unmatched)+renderErd(e)+"</div>"}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __run(e,t){var n;try{n=JSON.parse(e)}catch(c){n=null}if(!n)return __notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002");for(var s="",o=n.bases||[],i=0;i<o.length;i++)s+=renderErdBase(o[i]);return s||__notice("\u56F3\u306B\u3067\u304D\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002")}return __run(analysis_json,options_json);

""";

DECLARE js_page STRING DEFAULT r"""
const MAX_TABS=12,MAX_SQL_TABS=128,MAX_DESC_TABS=16,MAX_LABEL_TABS=8,OUTER_TABS=["note","\u30AB\u30E9\u30E0\u5B9A\u7FA9","\u53C2\u7167\u95A2\u4FC2","\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206","SQL"],MAX_OUTER_TABS=8,NOTE_MARK="<!--VG_NOTE-->",CSS_GEN=10;function cssGuard(){return`<div class="vg-cssgen10" style="margin:0 0 10px;padding:8px 12px;border:1px solid #D4A72C;border-radius:6px;background:#FFF8C5;color:#7D4E00;font:12px/1.6 'Roboto','Segoe UI',system-ui,sans-serif">\u3053\u306E\u30AB\u30FC\u30C9\u306B\u306F\u65B0\u3057\u3044 CSS\uFF08\u4E16\u4EE3 10\uFF09\u304C\u8981\u308A\u307E\u3059\u3002template_style.html \u3092\u8CBC\u308A\u76F4\u3057\u3066\u304F\u3060\u3055\u3044\u3002\u8CBC\u308A\u66FF\u3048\u308B\u307E\u3067\u3001\u30BF\u30D6\u304C\u6B63\u3057\u304F\u51FA\u307E\u305B\u3093\uFF08\u5207\u308A\u66FF\u308F\u3089\u306A\u3044\u30FB\u4E2D\u8EAB\u304C\u5168\u90E8\u540C\u6642\u306B\u51FA\u308B\u30FB\u9078\u629E\u4E2D\u304C\u5206\u304B\u3089\u306A\u3044\uFF09\u3002</div>`}function groupRule(s,n,e){const l=[];for(let t=1;t<=s;t++){const o=n(t);if(Array.isArray(o))for(const r of o)l.push(r);else l.push(o)}return l.join(",")+"{"+e+"}"}function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(s){let n=2166136261;for(let e=0;e<String(s).length;e++)n^=String(s).charCodeAt(e),n=Math.imul(n,16777619)>>>0;return n.toString(36)}const label=s=>s.suffixes.map((n,e)=>n||s.members[e]&&s.members[e].viewName||"(suffix \u306A\u3057)").join(", ");function badge(s,n,e){return`<span class="vg-badge" style="color:${n};background:${e}">${esc(s)}</span>`}function header(s,n,e,l,t){const o=e>1;return`<div class="vg-header"><span class="vg-title">${esc(s)}</span>`+badge(`${n} View`,"#57606A","#EAEEF2")+badge(`${e} \u30B0\u30EB\u30FC\u30D7`,o?"#9A6700":"#1A7F37",o?"#FFF8C5":"#DAFBE1")+(l?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+(t?badge("\u30E9\u30D9\u30EB\u4E0D\u4E00\u81F4","#9A6700","#FFF8C5"):"")+"</div>"}function notice(s){return`<div class="vg-notice">${esc(s)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=s=>KIND_TEXT[s]||s;function wrapPage(s,n,e,l,t,o,r){const i=o||{},c="vgo"+hashId(i.base||""),a=[`<div class="vg-root">${t==null||t===""?NOTE_MARK:String(t)}</div>`,e,n,s,l],g=OUTER_TABS.map((m,f)=>`<input class="vg-or vg-or${f+1}" type="radio" name="${c}" id="${c}-${f+1}"${f===0?" checked":""}>`).join(""),p=OUTER_TABS.map((m,f)=>`<label class="vg-otab vg-ot${f+1}" for="${c}-${f+1}">${esc(m)}</label>`).join(""),h=OUTER_TABS.map((m,f)=>`<div class="vg-opanel vg-op${f+1}">${a[f]||""}</div>`).join(""),v=i.base?header(i.base,i.viewCount,(i.groups||[]).length,i.unmatched,r):"";return`<div class="vg-outer">${cssGuard()}${g}<div class="vg-otablist">${v}${p}</div><div class="vg-opanels">${h}</div></div>`}const WARN="\u26A0",MAX_TABLE_W=1e3,MIN_COL_W=150,NAME_COL_W=180;function breakType(s){return String(s).replace(/(&lt;|,)/g,"$1<wbr>")}const DESC_JA_KEYS=["ja","jp","ja_name","name_ja","japanese","logical_name_ja","logicalNameJa","ja_logical_name","\u548C\u540D","\u65E5\u672C\u8A9E","\u65E5\u672C\u8A9E\u8AD6\u7406\u540D","\u8AD6\u7406\u540D"],DESC_EN_KEYS=["en","en_name","name_en","english","logical_name_en","logicalNameEn","en_logical_name","\u82F1\u8A9E","\u82F1\u8A9E\u8AD6\u7406\u540D"];function pickKey(s,n){for(let e=0;e<n.length;e++){const l=n[e];if(!Object.prototype.hasOwnProperty.call(s,l))continue;const t=s[l];if(!(t==null||String(t)===""))return{key:l,value:String(t)}}return null}function parseDesc(s){const n=String(s==null?"":s).trim();if(!n)return null;if(n.charAt(0)!=="{")return{raw:n};let e=null;try{e=JSON.parse(n)}catch(u){e=null}if(!e||typeof e!="object"||Array.isArray(e))return{raw:n};const l=pickKey(e,DESC_JA_KEYS),t=pickKey(e,DESC_EN_KEYS),o={};l&&(o[l.key]=!0),t&&(o[t.key]=!0);const r=[],i=Object.keys(e);for(let u=0;u<i.length;u++){const a=i[u];if(o[a])continue;const g=e[a];g==null||g===""||r.push({key:a,value:typeof g=="object"?JSON.stringify(g):String(g)})}const c=[];l&&c.push(l),t&&c.push(t);for(let u=0;u<r.length;u++)c.push(r[u]);return{ja:l?l.value:"",en:t?t.value:"",rest:r,pairs:c}}function descHtml(s){const n=parseDesc(s);return n?n.raw?`<div class="vg-cdesc">${esc(n.raw)}</div>`:n.pairs.length?`<table class="vg-cdtable">${n.pairs.map(l=>`<tr><th class="vg-cdk">${esc(l.key)}</th><td class="vg-cdv">${esc(l.value)}</td></tr>`).join("")}</table>`:"":""}function structFields(s){const n=String(s==null?"":s),e=n.indexOf("STRUCT<");if(e<0)return[];const l=[];let t="",o=0;for(let i=e+7;i<n.length;i++){const c=n.charAt(i);if(c===">"&&o===0){l.push(t);break}if(c==="<")o++;else if(c===">")o--;else if(c===","&&o===0){l.push(t),t="";continue}t+=c}const r=[];for(let i=0;i<l.length;i++){const c=l[i].trim().split(/[\s<]/)[0];c&&r.push(c)}return r}function assignOrder(s){const n=e=>("000"+e).slice(-4);for(const e of s.values()){const l=e.name.split("."),t=s.get(l[0]),o=t&&t.vals[0]&&t.vals[0].ord!=null?t.vals[0].ord:9999;let r=n(o),i=l[0];for(let c=1;c<l.length;c++){const u=s.get(i),g=(u&&u.vals[0]?structFields(u.vals[0].type):[]).indexOf(l[c]);r+="."+n(g<0?9999:g),i+="."+l[c]}e.sortKey=r}}function typeShape(s){const n=String(s==null?"":s).trim(),e=n.slice(0,6).toUpperCase()==="ARRAY<";let l=n;e&&(l=n.slice(n.indexOf("<")+1,n.lastIndexOf(">")).trim());const t=l.slice(0,7).toUpperCase()==="STRUCT<";return{repeated:e,record:t,name:t?"RECORD":l}}const isNested=s=>String(s).indexOf(".")>=0;function columnSig(s){const n=(s||[]).map(e=>[String(e.n==null?"":e.n),String(e.t==null?"":e.t),e.u==null||e.u===""?"":String(e.u).toUpperCase(),String(e.d==null?"":e.d)].join("\u0001"));return n.sort(),n.join("\u0002")}function columnGroups(s,n){const e=new Map,l=[],t=s&&s.groups||[];for(let r=0;r<t.length;r++){const i=t[r],c=i.members||[];for(let u=0;u<c.length;u++){const a=c[u],g=columnSig(n[a.viewName]);let p=e.get(g);p||(p={suffixes:[],members:[]},e.set(g,p),l.push(p)),p.suffixes.push((i.suffixes&&i.suffixes[u])!=null?i.suffixes[u]:null),p.members.push(a)}}const o=r=>String(r.suffixes[0]==null?r.members[0].viewName:r.suffixes[0]);for(const r of l){const i=r.members.map((c,u)=>u).sort((c,u)=>{const a=String(r.suffixes[c]==null?r.members[c].viewName:r.suffixes[c]),g=String(r.suffixes[u]==null?r.members[u].viewName:r.suffixes[u]);return a<g?-1:a>g?1:0});r.suffixes=i.map(c=>r.suffixes[c]),r.members=i.map(c=>r.members[c])}return l.sort((r,i)=>i.members.length-r.members.length||(o(r)<o(i)?-1:o(r)>o(i)?1:0)),l}function descCell(s){return!s||!s.descs.length?"":s.descs.length===1?descHtml(s.descs[0].text):s.descs.map(n=>`<div class="vg-cdescwho">${esc(n.suffixes.join(", "))}</div>`+descHtml(n.text)).join("")}function groupColumns(s,n){const e=new Map,l=s.members||[];for(let t=0;t<l.length;t++){const o=l[t],r=s.suffixes&&s.suffixes[t]||o.viewName,i=n[o.viewName]||[];for(let c=0;c<i.length;c++){const u=i[c];let a=e.get(u.n);if(a||(a={name:u.n,descs:[],order:c,vals:[]},e.set(u.n,a)),u.d){const g=String(u.d);let p=null;for(let h=0;h<a.descs.length;h++)a.descs[h].text===g&&(p=a.descs[h]);p?p.suffixes.push(r):a.descs.push({text:g,suffixes:[r]})}a.vals.push({suffix:r,type:u.t,ord:u.o==null?c+1:u.o,nullable:u.u==null||u.u===""?null:String(u.u).toUpperCase()!=="NO"})}}return assignOrder(e),e}function columnOrder(s){const n=new Set,e=[];for(const l of s){const t=[...l.values()].sort((o,r)=>o.sortKey<r.sortKey?-1:o.sortKey>r.sortKey?1:0);for(const o of t)n.has(o.name)||(n.add(o.name),e.push(o.name))}return e}function majority(s){const n=new Map;for(const t of s)n.set(t,(n.get(t)||0)+1);let e=null,l=-1;for(const t of s){const o=n.get(t);o>l&&(e=t,l=o)}return e}const nullText=s=>s===null?"UNKNOWN":s?"NULLABLE":"REQUIRED";function uniq(s){const n=[];for(const e of s)n.indexOf(e)<0&&n.push(e);return n}function cellInfo(s,n){if(!s)return{text:null,meta:"",sig:null,mixed:!1};const e=uniq(s.vals.map(i=>i.type)),l=uniq(s.vals.map(i=>nullText(i.nullable))),t=uniq(s.vals.map(i=>String(i.ord))).length>1||s.vals.length!==n,o=s.vals.map(i=>typeShape(i.type)),r=s.descs.map(i=>i.text).join("\u0001");return{text:e.join(" / "),shape:uniq(o.map(i=>i.name)).join(" / "),repeated:o.length>0&&o.every(i=>i.repeated),record:o.some(i=>i.record),nulls:l.join(" / "),sig:e.join(" / ")+"|"+l.join(" / ")+"|"+r,mixed:t}}function mixedTip(s,n){const e=isNested(s.name),l=s.vals.map(o=>e?`${o.suffix} = ${o.type}`:`${o.suffix} = #${o.ord} ${o.type} ${nullText(o.nullable)}`),t=s.vals.map(o=>o.suffix);for(let o=0;o<(n.members||[]).length;o++){const r=n.suffixes&&n.suffixes[o]||n.members[o].viewName;t.indexOf(r)<0&&l.push(`${r} = (\u3053\u306E\u5217\u3092\u6301\u305F\u306A\u3044)`)}return l.join(`
`)}function renderColumns(s,n){if(!(s.groups||[]).length)return notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");const e=columnGroups(s,n||{}),l=e.map(v=>groupColumns(v,n||{})),t=columnOrder(l);if(!t.length)return notice("\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.COLUMNS \u304B\u3089\u5217\u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");const o=new Set;for(const v of t){const m=v.lastIndexOf(".");m>0&&o.add(v.slice(0,m))}let r=0,i=0;const c=t.map(v=>{const m=v.split("."),f=m.length-1,_=f>0,b=e.map((d,$)=>cellInfo(l[$].get(v),d.members.length)),S=majority(b.map(d=>d.sig));b.some(d=>d.sig!==S)&&r++;const w=b.map((d,$)=>{const O=e[$],N=l[$].get(v),j=["vg-ccell"];d.text?d.sig!==S&&j.push("vg-cdiff"):j.push("vg-cnone"),d.mixed&&(j.push("vg-cmix"),i++);const C=!d.record||o.has(v)?d.shape:d.text,E=_?d.repeated?"REPEATED":"":d.repeated?"REPEATED":d.nulls,T=d.text?breakType(esc(C))+(d.mixed?`<span class="vg-cwarn" data-tip="${esc(mixedTip(N,O))}">${WARN}</span>`:"")+(E?`<span class="vg-cmeta">${esc(E)}</span>`:"")+descCell(N):"\u2014";return`<td class="${j.join(" ")}">${T}</td>`}).join(""),y="vg-cname"+(f?` vg-cd${Math.min(f,3)}`:""),x=f?`<span class="vg-cnestmark">\u2514</span>${esc(m[m.length-1])}`:esc(v);return`<tr><th class="${y}">${x}</th>${w}</tr>`}).join(""),u=e.map(v=>`<th class="vg-chead">${esc(label(v))}<span class="vg-tabn">${v.members.length}</span></th>`).join(""),a=[];e.length===1?a.push(notice(`${s.viewCount||e[0].members.length} \u672C\u306E View \u3059\u3079\u3066\u3067\u30AB\u30E9\u30E0\u5B9A\u7FA9\uFF08\u5217\u540D\u30FB\u578B\u30FB\u30E2\u30FC\u30C9\u30FB\u8AAC\u660E\uFF09\u304C\u4E00\u81F4\u3057\u3066\u3044\u307E\u3059\u3002`)):(a.push(notice(`\u30AB\u30E9\u30E0\u5B9A\u7FA9\u304C ${e.length} \u7A2E\u985E\u3042\u308A\u307E\u3059\uFF08\u5217\u304C\u305D\u306E\u672C\u6570\uFF09\u3002\u5217\u306F\u30ED\u30B8\u30C3\u30AF \u30B0\u30EB\u30FC\u30D7\u3067\u306F\u306A\u304F\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3067\u675F\u306D\u3066\u3044\u308B\u306E\u3067\u3001SQL \u304C\u540C\u4E00\u3067\u3082\u53C2\u7167\u5148\u30C6\u30FC\u30D6\u30EB\u306E\u578B\u3084 description \u304C\u9055\u3048\u3070\u5225\u306E\u5217\u306B\u306A\u308A\u307E\u3059\uFF08\u30ED\u30B8\u30C3\u30AF\u5DEE\u5206\u306E\u30BF\u30D6\u306B\u306F\u51FA\u3066\u3053\u306A\u3044\u5DEE\u3067\u3059\uFF09\u3002`)),r&&a.push(notice(`\u578B\u30FB\u30E2\u30FC\u30C9\u30FB\u8AAC\u660E\u306E\u3044\u305A\u308C\u304B\u304C\u63C3\u3063\u3066\u3044\u306A\u3044\u5217\u304C ${r} \u4EF6\u3042\u308A\u307E\u3059\uFF08\u8272\u4ED8\u304D\u306E\u30BB\u30EB\u3002\u305D\u306E\u5217\u3067\u3044\u3061\u3070\u3093\u591A\u3044\u5185\u5BB9\u3068\u9055\u3046\u3082\u306E\uFF09\u3002`))),i&&a.push(notice(`\u540C\u3058\u5217\u306E\u4E2D\u3067\u4E26\u3073\u9806\uFF08ordinal\uFF09\u3060\u3051\u304C\u98DF\u3044\u9055\u3063\u3066\u3044\u308B\u7B87\u6240\u304C${i} \u4EF6\u3042\u308A\u307E\u3059\uFF08${WARN} \u306E\u5370\u3002\u30DB\u30D0\u30FC\u3059\u308B\u3068 suffix \u3054\u3068\u306E\u5185\u8A33\u304C\u51FA\u307E\u3059\uFF09\u3002\u4E26\u3073\u9806\u306F\u5217\u306E\u675F\u306D\u65B9\u306B\u3082\u8868\u306E\u4E2D\u8EAB\u306B\u3082\u4F7F\u3063\u3066\u3044\u306A\u3044\u306E\u3067\u3001\u3053\u3053\u306B\u3060\u3051\u51FA\u307E\u3059\u3002`));const g=`<colgroup><col style="width:${NAME_COL_W}px">`+e.map(()=>"<col>").join("")+"</colgroup>",p=NAME_COL_W+MIN_COL_W*e.length,h=p>MAX_TABLE_W?` style="min-width:${p}px"`:"";return a.join("")+`<div class="vg-ctablewrap"><table class="vg-ctable"${h}>${g}<thead><tr><th class="vg-chead vg-cnamehead">\u5217\u540D</th>${u}</tr></thead><tbody>${c}</tbody></table></div>`}function renderColumnsBase(s,n){return`<div class="vg-root">${renderColumns(s,n)}</div>`}function sqlViews(s){const n=[],e=s.groups||[];for(let l=0;l<e.length;l++){const t=e[l],o=t.members||[];for(let r=0;r<o.length;r++)n.push({suffix:t.suffixes&&t.suffixes[r]||o[r].viewName||"(suffix \u306A\u3057)",viewName:o[r].viewName,group:label(t),groupSize:o.length})}return n.sort((l,t)=>{const o=String(l.suffix),r=String(t.suffix);return o.length-r.length||o.localeCompare(r)}),n}function sqlBody(s){const n=String(s).replace(/\r\n?/g,`
`).split(`
`);for(;n.length>1&&n[n.length-1].trim()==="";)n.pop();const e=String(n.length).length;return{html:`<div class="vg-sqlbox"><pre class="vg-sqlpre">${n.map((t,o)=>{const r=String(o+1);return`<span class="vg-sqln">${new Array(e-r.length+1).join(" ")}${r}</span> `+esc(t)}).join(`
`)}</pre></div>`,lines:n.length}}function sqlPanel(s,n){if(n==null||String(n)==="")return`<div class="vg-sqlhead"><span class="vg-sqlname">${esc(s.viewName)}</span></div>`+notice("\u3053\u306E View \u306E SQL \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002");const e=sqlBody(n);return`<div class="vg-sqlhead"><span class="vg-sqlname">${esc(s.viewName)}</span><span class="vg-sqlmeta">\u30B0\u30EB\u30FC\u30D7: ${esc(s.group)}</span><span class="vg-sqlmeta">${e.lines} \u884C</span></div>`+e.html}function renderSql(s,n){const e=sqlViews(s);if(!e.length)return notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");const l=n||{};if(!e.some(a=>l[a.viewName]))return notice("SQL \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.VIEWS \u304B\u3089 view_definition \u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");const t=e.slice(0,128),o="vgs"+hashId(s.base+"|"+e.map(a=>a.viewName).join("|")),r=t.map((a,g)=>`<input class="vg-sr vg-sr${g+1}" type="radio" name="${o}" id="${o}-${g+1}"${g===0?" checked":""}>`).join(""),i=t.map((a,g)=>`<label class="vg-stab vg-st${g+1}" for="${o}-${g+1}">${esc(a.suffix)}</label>`).join(""),c=t.map((a,g)=>`<div class="vg-spanel vg-sp${g+1}">${sqlPanel(a,l[a.viewName])}</div>`).join("");return(e.length>t.length?notice(`View \u304C\u591A\u3044\u305F\u3081\u5148\u982D 128 \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${e.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-stabs">${r}<div class="vg-stablist"><span class="vg-slabel">View</span>${i}</div><div class="vg-spanels">${c}</div></div>`}function renderSqlBase(s,n){return`<div class="vg-root">${renderSql(s,n)}</div>`}const DESC_TAB_ON="background:#EAEEF2;border-color:#8C959F;color:#24292F";function suffixByView(s){const n={},e=s&&s.groups||[];for(let l=0;l<e.length;l++){const t=e[l],o=t.members||[];for(let r=0;r<o.length;r++){const i=o[r]&&o[r].viewName;i&&(n[i]=t.suffixes&&t.suffixes[r]||i)}}return n}const cmp=(s,n)=>s<n?-1:s>n?1:0;function regionByView(s){const n={},e=Array.isArray(s)?s:[];for(let l=0;l<e.length;l++){const t=e[l]||{},o=Array.isArray(t.v)?t.v:[];for(let r=0;r<o.length;r++)n[o[r]]=String(t.r==null?"":t.r)}return n}function tabGroups(s,n,e){const l=suffixByView(s),t=Array.isArray(n)?n:[],o=[];for(let r=0;r<t.length;r++){const i=t[r]||{},c=Array.isArray(i.v)?i.v:i.v==null||i.v===""?[]:[i.v],u={label:c.map(a=>l[a]||a).sort(cmp).join(", ")||"(View \u306A\u3057)",count:c.length};e(u,i),o.push(u)}return o.sort((r,i)=>(r.empty===i.empty?0:r.empty?1:-1)||i.count-r.count||cmp(r.label,i.label)),o}function descGroups(s,n){return tabGroups(s,n,(e,l)=>{e.html=String(l.h==null?"":l.h),e.empty=e.html.trim()===""})}function labelGroups(s,n){return tabGroups(s,n,(e,l)=>{const t=Array.isArray(l.l)?l.l:[],o=[];for(let r=0;r<t.length;r++){const i=t[r]||{},c=String(i.k==null?"":i.k);c!==""&&o.push({k:c,v:String(i.v==null?"":i.v)})}o.sort((r,i)=>cmp(r.k,i.k)),e.pairs=o,e.empty=o.length===0})}function descPanel(s){return s.empty?notice("description \u304C\u8A2D\u5B9A\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"):s.html}const tabText=s=>`${esc(s.label)}<span class="vg-tabn">${s.count}</span>`;function renderDesc(s,n){const e=descGroups(s,n),l='<div class="vg-nhead">View \u306E description</div>';if(!e.length)return`<div class="vg-nsec">${l}`+notice("View \u306E description \u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002INFORMATION_SCHEMA.TABLE_OPTIONS \u304C\u8AAD\u3081\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002")+"</div>";if(e.every(a=>a.empty))return"";if(e.length===1)return`<div class="vg-nsec">${l}<div class="vg-dtablist"><span class="vg-dtab vg-dstatic">${tabText(e[0])}</span></div><div class="vg-dbox">${descPanel(e[0])}</div></div>`;const t=e.slice(0,16),o="vgd"+hashId((s&&s.base||"")+"|"+e.map(a=>a.label).join("|")),r=t.map((a,g)=>`<input class="vg-dr vg-dr${g+1}" type="radio" name="${o}" id="${o}-${g+1}"${g===0?" checked":""}>`).join(""),i=t.map((a,g)=>`<label class="vg-dtab vg-dt${g+1}" for="${o}-${g+1}">${tabText(a)}</label>`).join(""),c=t.map((a,g)=>`<div class="vg-dpanel vg-dp${g+1}">${descPanel(a)}</div>`).join(""),u=e.length>t.length?notice(`description \u304C\u591A\u3044\u305F\u3081\u5148\u982D 16 \u7A2E\u985E\u306E\u307F\u51FA\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${e.length} \u7A2E\u985E\uFF09\u3002`):"";return`<div class="vg-nsec">${l}${u}<div class="vg-dtabs">${r}<div class="vg-dtablist">${i}</div><div class="vg-dpanels">${c}</div></div></div>`}function labelChips(s){return s.empty?notice("\u30E9\u30D9\u30EB\u304C\u8A2D\u5B9A\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"):'<div class="vg-lbchips">'+s.pairs.map(n=>`<span class="vg-lbchip"><span class="vg-lbk">${esc(n.k)}</span><span class="vg-lbv">${esc(n.v||"(\u7A7A)")}</span></span>`).join("")+"</div>"}function labelsSplit(s,n){return labelGroups(s,n).length>1}function renderLabels(s,n){const e=labelGroups(s,n);if(!e.length||e[0].empty)return"";if(e.length===1)return labelChips(e[0]);const l=e.slice(0,8),t="vgl"+hashId((s&&s.base||"")+"|"+e.map(u=>u.label+"="+u.pairs.map(a=>a.k+":"+a.v).join(",")).join("|")),o=l.map((u,a)=>`<input class="vg-lbr vg-lbr${a+1}" type="radio" name="${t}" id="${t}-${a+1}"${a===0?" checked":""}>`).join(""),r=l.map((u,a)=>`<label class="vg-lbtab vg-lbt${a+1}" for="${t}-${a+1}">${tabText(u)}</label>`).join(""),i=l.map((u,a)=>`<div class="vg-lbpanel vg-lbp${a+1}">${labelChips(u)}</div>`).join(""),c=e.length>l.length?notice(`\u30E9\u30D9\u30EB\u306E\u7A2E\u985E\u304C\u591A\u3044\u305F\u3081\u5148\u982D 8 \u7A2E\u985E\u306E\u307F\u51FA\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${e.length} \u7A2E\u985E\uFF09\u3002`):"";return'<div class="vg-nsec"><div class="vg-nhead">\u30E9\u30D9\u30EB</div>'+notice("\u540C\u3058 base \u306E\u4E2D\u3067\u30E9\u30D9\u30EB\u304C\u5272\u308C\u3066\u3044\u307E\u3059\u3002")+c+`<div class="vg-lbtabs">${o}<div class="vg-lbtablist">${r}</div><div class="vg-lbpanels">${i}</div></div></div>`}function renderRegions(s,n){const e=regionByView(n),l=suffixByView(s),t=new Map,o=s&&s.groups||[];for(let i=0;i<o.length;i++){const c=o[i].members||[];for(let u=0;u<c.length;u++){const a=c[u].viewName,g=e[a];g==null||g===""||(t.has(g)||t.set(g,[]),t.get(g).push(l[a]||a))}}return t.size?`<div class="vg-nsec"><div class="vg-nhead">View \u306E\u30EA\u30FC\u30B8\u30E7\u30F3</div><table class="vg-loctable">${[...t.keys()].sort(cmp).map(i=>`<tr><th class="vg-lock">${esc(i)}</th><td class="vg-locn">${t.get(i).length}</td><td class="vg-locv">${esc(t.get(i).slice().sort(cmp).join(", "))}</td></tr>`).join("")}</table></div>`:""}function renderNote(s,n,e,l,t){const o=String(e==null?"":e);return renderLabels(s,l)+renderRegions(s,t)+renderDesc(s,n)+`<div class="vg-nsec"><div class="vg-nhead">\u30E1\u30E2</div>${o}</div>`}function __opts(s){if(!s)return{};try{return JSON.parse(s)||{}}catch(n){return{}}}function __notice(s){return'<div class="vg-notice">'+String(s).replace(/[<>&]/g,"")+"</div>"}function __run(s,n,e,l,t,o,r,i,c){var u=__opts(c),a;try{a=JSON.parse(s)}catch($){a=null}if(!a)return String(n||__notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002"));var g={};try{for(var p=JSON.parse(l)||[],h=0;h<p.length;h++)g[p[h].v]=p[h].cols||[]}catch($){g={}}var v={};try{for(var m=JSON.parse(t)||[],f=0;f<m.length;f++)v[m[f].v]=m[f].s}catch($){v={}}var _=[];try{_=JSON.parse(o)||[]}catch($){_=[]}var b=[];try{b=JSON.parse(r)||[]}catch($){b=[]}var S=[];try{S=JSON.parse(i)||[]}catch($){S=[]}for(var A="",w="",y=a.bases||[],x=0;x<y.length;x++)A+=renderColumnsBase(y[x],g),w+=renderSqlBase(y[x],v);A||(A=__notice("\u30AB\u30E9\u30E0\u5B9A\u7FA9\u3092\u51FA\u305B\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002")),w||(w=__notice("SQL \u3092\u51FA\u305B\u308B View \u304C\u3042\u308A\u307E\u305B\u3093\u3002"));var d=a.bases&&a.bases.length?a.bases[0]:null;return wrapPage(String(n||""),String(e||__notice("\u53C2\u7167\u95A2\u4FC2\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002")),A,w,renderNote(d,_,NOTE_MARK,b,S),d,labelsSplit(d,b))}return __run(analysis_json,diff_html,erd_html,columns_json,sql_json,descs_json,labels_json,regions_json,options_json);

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
-- 配る CSS。**関数の定義本文は 32 KB まで**（JavaScript でも SQL でも同じ）
-- なので、1 本には載らない。分けて載せ、まとめ役が連結して返す。
DECLARE css_part_1 STRING DEFAULT r""".vg-cssgen10{display:none}
.vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}
.vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}
.vg-title{font-weight:600;font-size:15px;line-height:1.6;color:#1A1A1A}
.vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}
.vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}
.vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}
.vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid #D0D7DE;background:#F6F8FA;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}
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
.vg-refhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px;padding:0 0 8px;border-bottom:1px solid #D0D7DE}
.vg-blabel{color:#57606A;font-size:12px;font-weight:600;margin-right:2px}
.vg-refname{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:13px;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-refnote{color:#57606A;font-size:11px}
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
.vg-or1:checked ~ .vg-opanels > .vg-op1,.vg-or2:checked ~ .vg-opanels > .vg-op2,.vg-or3:checked ~ .vg-opanels > .vg-op3,.vg-or4:checked ~ .vg-opanels > .vg-op4,.vg-or5:checked ~ .vg-opanels > .vg-op5,.vg-or6:checked ~ .vg-opanels > .vg-op6,.vg-or7:checked ~ .vg-opanels > .vg-op7,.vg-or8:checked ~ .vg-opanels > .vg-op8{display:block}
.vg-or1:checked ~ .vg-otablist > .vg-ot1,.vg-or1:checked ~ .vg-ohead > .vg-otablist > .vg-ot1,.vg-or2:checked ~ .vg-otablist > .vg-ot2,.vg-or2:checked ~ .vg-ohead > .vg-otablist > .vg-ot2,.vg-or3:checked ~ .vg-otablist > .vg-ot3,.vg-or3:checked ~ .vg-ohead > .vg-otablist > .vg-ot3,.vg-or4:checked ~ .vg-otablist > .vg-ot4,.vg-or4:checked ~ .vg-ohead > .vg-otablist > .vg-ot4,.vg-or5:checked ~ .vg-otablist > .vg-ot5,.vg-or5:checked ~ .vg-ohead > .vg-otablist > .vg-ot5,.vg-or6:checked ~ .vg-otablist > .vg-ot6,.vg-or6:checked ~ .vg-ohead > .vg-otablist > .vg-ot6,.vg-or7:checked ~ .vg-otablist > .vg-ot7,.vg-or7:checked ~ .vg-ohead > .vg-otablist > .vg-ot7,.vg-or8:checked ~ .vg-otablist > .vg-ot8,.vg-or8:checked ~ .vg-ohead > .vg-otablist > .vg-ot8{background:#24292F;border-color:#24292F;color:#fff}
.vg-r1:checked ~ .vg-panels > .vg-p1,.vg-r2:checked ~ .vg-panels > .vg-p2,.vg-r3:checked ~ .vg-panels > .vg-p3,.vg-r4:checked ~ .vg-panels > .vg-p4,.vg-r5:checked ~ .vg-panels > .vg-p5,.vg-r6:checked ~ .vg-panels > .vg-p6,.vg-r7:checked ~ .vg-panels > .vg-p7,.vg-r8:checked ~ .vg-panels > .vg-p8,.vg-r9:checked ~ .vg-panels > .vg-p9,.vg-r10:checked ~ .vg-panels > .vg-p10,.vg-r11:checked ~ .vg-panels > .vg-p11,.vg-r12:checked ~ .vg-panels > .vg-p12{display:block}
.vg-r1:checked ~ .vg-tablist > .vg-t1,.vg-r2:checked ~ .vg-tablist > .vg-t2,.vg-r3:checked ~ .vg-tablist > .vg-t3,.vg-r4:checked ~ .vg-tablist > .vg-t4,.vg-r5:checked ~ .vg-tablist > .vg-t5,.vg-r6:checked ~ .vg-tablist > .vg-t6,.vg-r7:checked ~ .vg-tablist > .vg-t7,.vg-r8:checked ~ .vg-tablist > .vg-t8,.vg-r9:checked ~ .vg-tablist > .vg-t9,.vg-r10:checked ~ .vg-tablist > .vg-t10,.vg-r11:checked ~ .vg-tablist > .vg-t11,.vg-r12:checked ~ .vg-tablist > .vg-t12{background:#f0f4ea;border-color:#c4d2ac;color:#24292F}
""";

DECLARE css_part_2 STRING DEFAULT r""".vg-r1:checked ~ .vg-tablist > .vg-t1 .vg-tabn,.vg-r2:checked ~ .vg-tablist > .vg-t2 .vg-tabn,.vg-r3:checked ~ .vg-tablist > .vg-t3 .vg-tabn,.vg-r4:checked ~ .vg-tablist > .vg-t4 .vg-tabn,.vg-r5:checked ~ .vg-tablist > .vg-t5 .vg-tabn,.vg-r6:checked ~ .vg-tablist > .vg-t6 .vg-tabn,.vg-r7:checked ~ .vg-tablist > .vg-t7 .vg-tabn,.vg-r8:checked ~ .vg-tablist > .vg-t8 .vg-tabn,.vg-r9:checked ~ .vg-tablist > .vg-t9 .vg-tabn,.vg-r10:checked ~ .vg-tablist > .vg-t10 .vg-tabn,.vg-r11:checked ~ .vg-tablist > .vg-t11 .vg-tabn,.vg-r12:checked ~ .vg-tablist > .vg-t12 .vg-tabn{background:#dfe7d2;color:#58683e}
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
""";

DECLARE css_part_3 STRING DEFAULT r""".vg-sr1:checked ~ .vg-spanels > .vg-sp1,.vg-sr2:checked ~ .vg-spanels > .vg-sp2,.vg-sr3:checked ~ .vg-spanels > .vg-sp3,.vg-sr4:checked ~ .vg-spanels > .vg-sp4,.vg-sr5:checked ~ .vg-spanels > .vg-sp5,.vg-sr6:checked ~ .vg-spanels > .vg-sp6,.vg-sr7:checked ~ .vg-spanels > .vg-sp7,.vg-sr8:checked ~ .vg-spanels > .vg-sp8,.vg-sr9:checked ~ .vg-spanels > .vg-sp9,.vg-sr10:checked ~ .vg-spanels > .vg-sp10,.vg-sr11:checked ~ .vg-spanels > .vg-sp11,.vg-sr12:checked ~ .vg-spanels > .vg-sp12,.vg-sr13:checked ~ .vg-spanels > .vg-sp13,.vg-sr14:checked ~ .vg-spanels > .vg-sp14,.vg-sr15:checked ~ .vg-spanels > .vg-sp15,.vg-sr16:checked ~ .vg-spanels > .vg-sp16,.vg-sr17:checked ~ .vg-spanels > .vg-sp17,.vg-sr18:checked ~ .vg-spanels > .vg-sp18,.vg-sr19:checked ~ .vg-spanels > .vg-sp19,.vg-sr20:checked ~ .vg-spanels > .vg-sp20,.vg-sr21:checked ~ .vg-spanels > .vg-sp21,.vg-sr22:checked ~ .vg-spanels > .vg-sp22,.vg-sr23:checked ~ .vg-spanels > .vg-sp23,.vg-sr24:checked ~ .vg-spanels > .vg-sp24,.vg-sr25:checked ~ .vg-spanels > .vg-sp25,.vg-sr26:checked ~ .vg-spanels > .vg-sp26,.vg-sr27:checked ~ .vg-spanels > .vg-sp27,.vg-sr28:checked ~ .vg-spanels > .vg-sp28,.vg-sr29:checked ~ .vg-spanels > .vg-sp29,.vg-sr30:checked ~ .vg-spanels > .vg-sp30,.vg-sr31:checked ~ .vg-spanels > .vg-sp31,.vg-sr32:checked ~ .vg-spanels > .vg-sp32,.vg-sr33:checked ~ .vg-spanels > .vg-sp33,.vg-sr34:checked ~ .vg-spanels > .vg-sp34,.vg-sr35:checked ~ .vg-spanels > .vg-sp35,.vg-sr36:checked ~ .vg-spanels > .vg-sp36,.vg-sr37:checked ~ .vg-spanels > .vg-sp37,.vg-sr38:checked ~ .vg-spanels > .vg-sp38,.vg-sr39:checked ~ .vg-spanels > .vg-sp39,.vg-sr40:checked ~ .vg-spanels > .vg-sp40,.vg-sr41:checked ~ .vg-spanels > .vg-sp41,.vg-sr42:checked ~ .vg-spanels > .vg-sp42,.vg-sr43:checked ~ .vg-spanels > .vg-sp43,.vg-sr44:checked ~ .vg-spanels > .vg-sp44,.vg-sr45:checked ~ .vg-spanels > .vg-sp45,.vg-sr46:checked ~ .vg-spanels > .vg-sp46,.vg-sr47:checked ~ .vg-spanels > .vg-sp47,.vg-sr48:checked ~ .vg-spanels > .vg-sp48,.vg-sr49:checked ~ .vg-spanels > .vg-sp49,.vg-sr50:checked ~ .vg-spanels > .vg-sp50,.vg-sr51:checked ~ .vg-spanels > .vg-sp51,.vg-sr52:checked ~ .vg-spanels > .vg-sp52,.vg-sr53:checked ~ .vg-spanels > .vg-sp53,.vg-sr54:checked ~ .vg-spanels > .vg-sp54,.vg-sr55:checked ~ .vg-spanels > .vg-sp55,.vg-sr56:checked ~ .vg-spanels > .vg-sp56,.vg-sr57:checked ~ .vg-spanels > .vg-sp57,.vg-sr58:checked ~ .vg-spanels > .vg-sp58,.vg-sr59:checked ~ .vg-spanels > .vg-sp59,.vg-sr60:checked ~ .vg-spanels > .vg-sp60,.vg-sr61:checked ~ .vg-spanels > .vg-sp61,.vg-sr62:checked ~ .vg-spanels > .vg-sp62,.vg-sr63:checked ~ .vg-spanels > .vg-sp63,.vg-sr64:checked ~ .vg-spanels > .vg-sp64,.vg-sr65:checked ~ .vg-spanels > .vg-sp65,.vg-sr66:checked ~ .vg-spanels > .vg-sp66,.vg-sr67:checked ~ .vg-spanels > .vg-sp67,.vg-sr68:checked ~ .vg-spanels > .vg-sp68,.vg-sr69:checked ~ .vg-spanels > .vg-sp69,.vg-sr70:checked ~ .vg-spanels > .vg-sp70,.vg-sr71:checked ~ .vg-spanels > .vg-sp71,.vg-sr72:checked ~ .vg-spanels > .vg-sp72,.vg-sr73:checked ~ .vg-spanels > .vg-sp73,.vg-sr74:checked ~ .vg-spanels > .vg-sp74,.vg-sr75:checked ~ .vg-spanels > .vg-sp75,.vg-sr76:checked ~ .vg-spanels > .vg-sp76,.vg-sr77:checked ~ .vg-spanels > .vg-sp77,.vg-sr78:checked ~ .vg-spanels > .vg-sp78,.vg-sr79:checked ~ .vg-spanels > .vg-sp79,.vg-sr80:checked ~ .vg-spanels > .vg-sp80,.vg-sr81:checked ~ .vg-spanels > .vg-sp81,.vg-sr82:checked ~ .vg-spanels > .vg-sp82,.vg-sr83:checked ~ .vg-spanels > .vg-sp83,.vg-sr84:checked ~ .vg-spanels > .vg-sp84,.vg-sr85:checked ~ .vg-spanels > .vg-sp85,.vg-sr86:checked ~ .vg-spanels > .vg-sp86,.vg-sr87:checked ~ .vg-spanels > .vg-sp87,.vg-sr88:checked ~ .vg-spanels > .vg-sp88,.vg-sr89:checked ~ .vg-spanels > .vg-sp89,.vg-sr90:checked ~ .vg-spanels > .vg-sp90,.vg-sr91:checked ~ .vg-spanels > .vg-sp91,.vg-sr92:checked ~ .vg-spanels > .vg-sp92,.vg-sr93:checked ~ .vg-spanels > .vg-sp93,.vg-sr94:checked ~ .vg-spanels > .vg-sp94,.vg-sr95:checked ~ .vg-spanels > .vg-sp95,.vg-sr96:checked ~ .vg-spanels > .vg-sp96,.vg-sr97:checked ~ .vg-spanels > .vg-sp97,.vg-sr98:checked ~ .vg-spanels > .vg-sp98,.vg-sr99:checked ~ .vg-spanels > .vg-sp99,.vg-sr100:checked ~ .vg-spanels > .vg-sp100,.vg-sr101:checked ~ .vg-spanels > .vg-sp101,.vg-sr102:checked ~ .vg-spanels > .vg-sp102,.vg-sr103:checked ~ .vg-spanels > .vg-sp103,.vg-sr104:checked ~ .vg-spanels > .vg-sp104,.vg-sr105:checked ~ .vg-spanels > .vg-sp105,.vg-sr106:checked ~ .vg-spanels > .vg-sp106,.vg-sr107:checked ~ .vg-spanels > .vg-sp107,.vg-sr108:checked ~ .vg-spanels > .vg-sp108,.vg-sr109:checked ~ .vg-spanels > .vg-sp109,.vg-sr110:checked ~ .vg-spanels > .vg-sp110,.vg-sr111:checked ~ .vg-spanels > .vg-sp111,.vg-sr112:checked ~ .vg-spanels > .vg-sp112,.vg-sr113:checked ~ .vg-spanels > .vg-sp113,.vg-sr114:checked ~ .vg-spanels > .vg-sp114,.vg-sr115:checked ~ .vg-spanels > .vg-sp115,.vg-sr116:checked ~ .vg-spanels > .vg-sp116,.vg-sr117:checked ~ .vg-spanels > .vg-sp117,.vg-sr118:checked ~ .vg-spanels > .vg-sp118,.vg-sr119:checked ~ .vg-spanels > .vg-sp119,.vg-sr120:checked ~ .vg-spanels > .vg-sp120,.vg-sr121:checked ~ .vg-spanels > .vg-sp121,.vg-sr122:checked ~ .vg-spanels > .vg-sp122,.vg-sr123:checked ~ .vg-spanels > .vg-sp123,.vg-sr124:checked ~ .vg-spanels > .vg-sp124,.vg-sr125:checked ~ .vg-spanels > .vg-sp125,.vg-sr126:checked ~ .vg-spanels > .vg-sp126,.vg-sr127:checked ~ .vg-spanels > .vg-sp127,.vg-sr128:checked ~ .vg-spanels > .vg-sp128{display:block}
""";

DECLARE css_part_4 STRING DEFAULT r""".vg-sr1:checked ~ .vg-stablist > .vg-st1,.vg-sr2:checked ~ .vg-stablist > .vg-st2,.vg-sr3:checked ~ .vg-stablist > .vg-st3,.vg-sr4:checked ~ .vg-stablist > .vg-st4,.vg-sr5:checked ~ .vg-stablist > .vg-st5,.vg-sr6:checked ~ .vg-stablist > .vg-st6,.vg-sr7:checked ~ .vg-stablist > .vg-st7,.vg-sr8:checked ~ .vg-stablist > .vg-st8,.vg-sr9:checked ~ .vg-stablist > .vg-st9,.vg-sr10:checked ~ .vg-stablist > .vg-st10,.vg-sr11:checked ~ .vg-stablist > .vg-st11,.vg-sr12:checked ~ .vg-stablist > .vg-st12,.vg-sr13:checked ~ .vg-stablist > .vg-st13,.vg-sr14:checked ~ .vg-stablist > .vg-st14,.vg-sr15:checked ~ .vg-stablist > .vg-st15,.vg-sr16:checked ~ .vg-stablist > .vg-st16,.vg-sr17:checked ~ .vg-stablist > .vg-st17,.vg-sr18:checked ~ .vg-stablist > .vg-st18,.vg-sr19:checked ~ .vg-stablist > .vg-st19,.vg-sr20:checked ~ .vg-stablist > .vg-st20,.vg-sr21:checked ~ .vg-stablist > .vg-st21,.vg-sr22:checked ~ .vg-stablist > .vg-st22,.vg-sr23:checked ~ .vg-stablist > .vg-st23,.vg-sr24:checked ~ .vg-stablist > .vg-st24,.vg-sr25:checked ~ .vg-stablist > .vg-st25,.vg-sr26:checked ~ .vg-stablist > .vg-st26,.vg-sr27:checked ~ .vg-stablist > .vg-st27,.vg-sr28:checked ~ .vg-stablist > .vg-st28,.vg-sr29:checked ~ .vg-stablist > .vg-st29,.vg-sr30:checked ~ .vg-stablist > .vg-st30,.vg-sr31:checked ~ .vg-stablist > .vg-st31,.vg-sr32:checked ~ .vg-stablist > .vg-st32,.vg-sr33:checked ~ .vg-stablist > .vg-st33,.vg-sr34:checked ~ .vg-stablist > .vg-st34,.vg-sr35:checked ~ .vg-stablist > .vg-st35,.vg-sr36:checked ~ .vg-stablist > .vg-st36,.vg-sr37:checked ~ .vg-stablist > .vg-st37,.vg-sr38:checked ~ .vg-stablist > .vg-st38,.vg-sr39:checked ~ .vg-stablist > .vg-st39,.vg-sr40:checked ~ .vg-stablist > .vg-st40,.vg-sr41:checked ~ .vg-stablist > .vg-st41,.vg-sr42:checked ~ .vg-stablist > .vg-st42,.vg-sr43:checked ~ .vg-stablist > .vg-st43,.vg-sr44:checked ~ .vg-stablist > .vg-st44,.vg-sr45:checked ~ .vg-stablist > .vg-st45,.vg-sr46:checked ~ .vg-stablist > .vg-st46,.vg-sr47:checked ~ .vg-stablist > .vg-st47,.vg-sr48:checked ~ .vg-stablist > .vg-st48,.vg-sr49:checked ~ .vg-stablist > .vg-st49,.vg-sr50:checked ~ .vg-stablist > .vg-st50,.vg-sr51:checked ~ .vg-stablist > .vg-st51,.vg-sr52:checked ~ .vg-stablist > .vg-st52,.vg-sr53:checked ~ .vg-stablist > .vg-st53,.vg-sr54:checked ~ .vg-stablist > .vg-st54,.vg-sr55:checked ~ .vg-stablist > .vg-st55,.vg-sr56:checked ~ .vg-stablist > .vg-st56,.vg-sr57:checked ~ .vg-stablist > .vg-st57,.vg-sr58:checked ~ .vg-stablist > .vg-st58,.vg-sr59:checked ~ .vg-stablist > .vg-st59,.vg-sr60:checked ~ .vg-stablist > .vg-st60,.vg-sr61:checked ~ .vg-stablist > .vg-st61,.vg-sr62:checked ~ .vg-stablist > .vg-st62,.vg-sr63:checked ~ .vg-stablist > .vg-st63,.vg-sr64:checked ~ .vg-stablist > .vg-st64,.vg-sr65:checked ~ .vg-stablist > .vg-st65,.vg-sr66:checked ~ .vg-stablist > .vg-st66,.vg-sr67:checked ~ .vg-stablist > .vg-st67,.vg-sr68:checked ~ .vg-stablist > .vg-st68,.vg-sr69:checked ~ .vg-stablist > .vg-st69,.vg-sr70:checked ~ .vg-stablist > .vg-st70,.vg-sr71:checked ~ .vg-stablist > .vg-st71,.vg-sr72:checked ~ .vg-stablist > .vg-st72,.vg-sr73:checked ~ .vg-stablist > .vg-st73,.vg-sr74:checked ~ .vg-stablist > .vg-st74,.vg-sr75:checked ~ .vg-stablist > .vg-st75,.vg-sr76:checked ~ .vg-stablist > .vg-st76,.vg-sr77:checked ~ .vg-stablist > .vg-st77,.vg-sr78:checked ~ .vg-stablist > .vg-st78,.vg-sr79:checked ~ .vg-stablist > .vg-st79,.vg-sr80:checked ~ .vg-stablist > .vg-st80,.vg-sr81:checked ~ .vg-stablist > .vg-st81,.vg-sr82:checked ~ .vg-stablist > .vg-st82,.vg-sr83:checked ~ .vg-stablist > .vg-st83,.vg-sr84:checked ~ .vg-stablist > .vg-st84,.vg-sr85:checked ~ .vg-stablist > .vg-st85,.vg-sr86:checked ~ .vg-stablist > .vg-st86,.vg-sr87:checked ~ .vg-stablist > .vg-st87,.vg-sr88:checked ~ .vg-stablist > .vg-st88,.vg-sr89:checked ~ .vg-stablist > .vg-st89,.vg-sr90:checked ~ .vg-stablist > .vg-st90,.vg-sr91:checked ~ .vg-stablist > .vg-st91,.vg-sr92:checked ~ .vg-stablist > .vg-st92,.vg-sr93:checked ~ .vg-stablist > .vg-st93,.vg-sr94:checked ~ .vg-stablist > .vg-st94,.vg-sr95:checked ~ .vg-stablist > .vg-st95,.vg-sr96:checked ~ .vg-stablist > .vg-st96,.vg-sr97:checked ~ .vg-stablist > .vg-st97,.vg-sr98:checked ~ .vg-stablist > .vg-st98,.vg-sr99:checked ~ .vg-stablist > .vg-st99,.vg-sr100:checked ~ .vg-stablist > .vg-st100,.vg-sr101:checked ~ .vg-stablist > .vg-st101,.vg-sr102:checked ~ .vg-stablist > .vg-st102,.vg-sr103:checked ~ .vg-stablist > .vg-st103,.vg-sr104:checked ~ .vg-stablist > .vg-st104,.vg-sr105:checked ~ .vg-stablist > .vg-st105,.vg-sr106:checked ~ .vg-stablist > .vg-st106,.vg-sr107:checked ~ .vg-stablist > .vg-st107,.vg-sr108:checked ~ .vg-stablist > .vg-st108,.vg-sr109:checked ~ .vg-stablist > .vg-st109,.vg-sr110:checked ~ .vg-stablist > .vg-st110,.vg-sr111:checked ~ .vg-stablist > .vg-st111,.vg-sr112:checked ~ .vg-stablist > .vg-st112,.vg-sr113:checked ~ .vg-stablist > .vg-st113,.vg-sr114:checked ~ .vg-stablist > .vg-st114,.vg-sr115:checked ~ .vg-stablist > .vg-st115,.vg-sr116:checked ~ .vg-stablist > .vg-st116,.vg-sr117:checked ~ .vg-stablist > .vg-st117,.vg-sr118:checked ~ .vg-stablist > .vg-st118,.vg-sr119:checked ~ .vg-stablist > .vg-st119,.vg-sr120:checked ~ .vg-stablist > .vg-st120,.vg-sr121:checked ~ .vg-stablist > .vg-st121,.vg-sr122:checked ~ .vg-stablist > .vg-st122,.vg-sr123:checked ~ .vg-stablist > .vg-st123,.vg-sr124:checked ~ .vg-stablist > .vg-st124,.vg-sr125:checked ~ .vg-stablist > .vg-st125,.vg-sr126:checked ~ .vg-stablist > .vg-st126,.vg-sr127:checked ~ .vg-stablist > .vg-st127,.vg-sr128:checked ~ .vg-stablist > .vg-st128{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}
.vg-nsec{margin:0 0 18px}
.vg-nsec:last-child{margin-bottom:0}
.vg-loctable{border-collapse:collapse}
.vg-loctable tr+tr th,.vg-loctable tr+tr td{border-top:1px solid #EAEEF2}
.vg-lock{text-align:left;vertical-align:top;padding:5px 12px 5px 0;white-space:nowrap;font-weight:600;font-size:12px;line-height:1.8;color:#24292F;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-locn{text-align:right;vertical-align:top;padding:5px 10px 5px 0;white-space:nowrap;color:#57606A;font-size:11px;line-height:1.9}
.vg-locv{padding:5px 0;font-size:12px;line-height:1.8;color:#57606A;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-nhead{margin:0 0 6px;padding:0 0 4px;border-bottom:1px solid #EAEEF2;font:11px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;font-weight:600;letter-spacing:.04em;color:#57606A}
.vg-dr,.vg-lbr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.vg-dtablist,.vg-lbtablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}
.vg-dtab,.vg-lbtab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid #D0D7DE;border-radius:14px;color:#57606A;cursor:pointer;user-select:none;font-weight:600;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-dtab:hover,.vg-lbtab:hover{background:#F6F8FA;color:#24292F}
.vg-dpanel,.vg-lbpanel{display:none}
.vg-dtab.vg-dstatic{background:#EAEEF2;border-color:#8C959F;color:#24292F;cursor:default}
.vg-lbchips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.vg-lbchip{display:inline-flex;align-items:stretch;border:1px solid #D0D7DE;border-radius:4px;overflow:hidden;font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}
.vg-lbk{padding:1px 7px;background:#F6F8FA;color:#57606A;font-weight:600;border-right:1px solid #D0D7DE}
.vg-lbv{padding:1px 8px;color:#24292F}
.vg-lbpanels .vg-lbchips{margin-bottom:0}
.vg-dr1:checked ~ .vg-dpanels > .vg-dp1,.vg-dr2:checked ~ .vg-dpanels > .vg-dp2,.vg-dr3:checked ~ .vg-dpanels > .vg-dp3,.vg-dr4:checked ~ .vg-dpanels > .vg-dp4,.vg-dr5:checked ~ .vg-dpanels > .vg-dp5,.vg-dr6:checked ~ .vg-dpanels > .vg-dp6,.vg-dr7:checked ~ .vg-dpanels > .vg-dp7,.vg-dr8:checked ~ .vg-dpanels > .vg-dp8,.vg-dr9:checked ~ .vg-dpanels > .vg-dp9,.vg-dr10:checked ~ .vg-dpanels > .vg-dp10,.vg-dr11:checked ~ .vg-dpanels > .vg-dp11,.vg-dr12:checked ~ .vg-dpanels > .vg-dp12,.vg-dr13:checked ~ .vg-dpanels > .vg-dp13,.vg-dr14:checked ~ .vg-dpanels > .vg-dp14,.vg-dr15:checked ~ .vg-dpanels > .vg-dp15,.vg-dr16:checked ~ .vg-dpanels > .vg-dp16{display:block}
.vg-dr1:checked ~ .vg-dtablist > .vg-dt1,.vg-dr2:checked ~ .vg-dtablist > .vg-dt2,.vg-dr3:checked ~ .vg-dtablist > .vg-dt3,.vg-dr4:checked ~ .vg-dtablist > .vg-dt4,.vg-dr5:checked ~ .vg-dtablist > .vg-dt5,.vg-dr6:checked ~ .vg-dtablist > .vg-dt6,.vg-dr7:checked ~ .vg-dtablist > .vg-dt7,.vg-dr8:checked ~ .vg-dtablist > .vg-dt8,.vg-dr9:checked ~ .vg-dtablist > .vg-dt9,.vg-dr10:checked ~ .vg-dtablist > .vg-dt10,.vg-dr11:checked ~ .vg-dtablist > .vg-dt11,.vg-dr12:checked ~ .vg-dtablist > .vg-dt12,.vg-dr13:checked ~ .vg-dtablist > .vg-dt13,.vg-dr14:checked ~ .vg-dtablist > .vg-dt14,.vg-dr15:checked ~ .vg-dtablist > .vg-dt15,.vg-dr16:checked ~ .vg-dtablist > .vg-dt16{background:#EAEEF2;border-color:#8C959F;color:#24292F}
.vg-lbr1:checked ~ .vg-lbpanels > .vg-lbp1,.vg-lbr2:checked ~ .vg-lbpanels > .vg-lbp2,.vg-lbr3:checked ~ .vg-lbpanels > .vg-lbp3,.vg-lbr4:checked ~ .vg-lbpanels > .vg-lbp4,.vg-lbr5:checked ~ .vg-lbpanels > .vg-lbp5,.vg-lbr6:checked ~ .vg-lbpanels > .vg-lbp6,.vg-lbr7:checked ~ .vg-lbpanels > .vg-lbp7,.vg-lbr8:checked ~ .vg-lbpanels > .vg-lbp8{display:block}
.vg-lbr1:checked ~ .vg-lbtablist > .vg-lbt1,.vg-lbr2:checked ~ .vg-lbtablist > .vg-lbt2,.vg-lbr3:checked ~ .vg-lbtablist > .vg-lbt3,.vg-lbr4:checked ~ .vg-lbtablist > .vg-lbt4,.vg-lbr5:checked ~ .vg-lbtablist > .vg-lbt5,.vg-lbr6:checked ~ .vg-lbtablist > .vg-lbt6,.vg-lbr7:checked ~ .vg-lbtablist > .vg-lbt7,.vg-lbr8:checked ~ .vg-lbtablist > .vg-lbt8{background:#EAEEF2;border-color:#8C959F;color:#24292F}
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
.duywfcf{padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:#24292F;background:#f6d7d7;border-left:2px solid #E17B7B;}""";

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
SET udf_css_p1_function_name =
  udf_name_prefix || system_name || '_' || 'group_css_p1' || udf_name_suffix;
SET udf_css_p2_function_name =
  udf_name_prefix || system_name || '_' || 'group_css_p2' || udf_name_suffix;
SET udf_css_p3_function_name =
  udf_name_prefix || system_name || '_' || 'group_css_p3' || udf_name_suffix;
SET udf_css_p4_function_name =
  udf_name_prefix || system_name || '_' || 'group_css_p4' || udf_name_suffix;
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
ASSERT REGEXP_CONTAINS(udf_css_p1_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_p1_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_p2_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_p2_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_p3_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_p3_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_p4_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_p4_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
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
--
-- ref_index は「どのグループを基準にするか」。
--   NULL      … 全基準をカードの中のタブで選べる形（従来）
--   0, 1, 2 … … その基準ぶんだけを作る。**行を基準ごとに分けるための道。**
--
-- **全基準を 1 枚に載せると比較ペインは G×(G−1) 枚で、グループ数の二乗**に
-- なる。リージョンをまたいで View を集めると G が伸び、UDF のメモリを
-- 使い切って日次の生成ごと落ちる（実際に落ちた）。二乗の係数 G は
-- 「どのグループも基準にできる」ことから来ているので、基準を行に分けると
-- 1 行 G−1 枚の線形に戻る。どの基準を見るかはレポートのコントロールで選ぶ。
--
-- **INT64 ではなく FLOAT64。** JS UDF は INT64 を扱えない。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(
  analysis_json STRING,
  options_json STRING,
  ref_index FLOAT64
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
-- note タブは三段。先頭が View に付いた labels、次が View 自身の description、
-- 最後がメモ。
--
-- ラベルは labels_json（[{v: [View 名...], l: [{k, v}...]}]）から作る。
-- **量に合わせて重さを変える。** 全 View で同じなら見出しを持たないチップ
-- 1 列、base の中で割れていればタブ付きの段に昇格し、見出しにも
-- 「ラベル不一致」のバッジが出る。1 つも付いていなければ何も出さない
-- （labels は付いていない View のほうが普通なので、「未設定」と書くと
-- 使っていない base 全部にその行が並ぶ）。キーはアルファベット順に並べ直す。
--
-- description は descs_json（[{v: [View 名...], h: HTML}]）から作る。
-- **Markdown を HTML にするのは呼び出し側の SQL（viewlgc_markdown）。**
-- JS UDF から別の UDF は呼べない。
-- 文面が割れている base ではタブになり、1 種類ならタブは出ない。
--
-- メモの中身はここでは入れない。パネルには目印 '<!--VG_NOTE-->' だけを
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
  labels_json STRING,
  regions_json STRING,
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
-- 部品。**関数の定義本文は 32 KB まで**なので、CSS はここに分けて載せる
-- （1 本に載せていた頃は 43,771 B になって CREATE が落ちた）。
-- 引数は取らない。呼ぶのは下のまとめ役だけで、直に呼ぶ用途は無い。
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`()
RETURNS STRING
AS (%s)
''',
  udf_project_id, udf_dataset, udf_css_p1_function_name,
  TO_JSON_STRING(css_part_1));

EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`()
RETURNS STRING
AS (%s)
''',
  udf_project_id, udf_dataset, udf_css_p2_function_name,
  TO_JSON_STRING(css_part_2));

EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`()
RETURNS STRING
AS (%s)
''',
  udf_project_id, udf_dataset, udf_css_p3_function_name,
  TO_JSON_STRING(css_part_3));

EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`()
RETURNS STRING
AS (%s)
''',
  udf_project_id, udf_dataset, udf_css_p4_function_name,
  TO_JSON_STRING(css_part_4));

-- まとめ役。**外から呼ぶのはこの名前**（build_table.sql の __UDF_CSS__）。
-- 部品を連結して返すだけなので、本体は数百バイトにしかならない。
-- 足りなくなったら CSS_PARTS を増やす（build_udf.mjs）。
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(options_json STRING)
RETURNS STRING
AS (`%s.%s.%s`() || `%s.%s.%s`() || `%s.%s.%s`() || `%s.%s.%s`())
''',
  udf_project_id, udf_dataset, udf_css_function_name,
  udf_project_id, udf_dataset, udf_css_p1_function_name,
  udf_project_id, udf_dataset, udf_css_p2_function_name,
  udf_project_id, udf_dataset, udf_css_p3_function_name,
  udf_project_id, udf_dataset, udf_css_p4_function_name);


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
--   __SRC_SCHEMATA__       SCHEMATA の読み元（SQL 片）
--   __SRC_VIEWS__          VIEWS の読み元（同上）
--   __SRC_COLUMNS__        COLUMNS の読み元（同上）
--   __SRC_FIELD_PATHS__    COLUMN_FIELD_PATHS の読み元（同上）
--   __SRC_TABLE_OPTS__     TABLE_OPTIONS の読み元（同上）
--
-- __SRC_*__ は「読み元」をまるごと差し替えるための目印。拠点だけを見るなら
-- リージョン修飾の INFORMATION_SCHEMA がそのまま入り、別リージョンぶんを
-- 混ぜるなら「拠点の INFORMATION_SCHEMA UNION ALL 運んできたテーブル」に
-- なる。**どちらを入れるかは build_table.sql が決める。** テンプレートは
-- 読み元の形を知らないので、混ぜる／混ぜないでテンプレートは変わらない。
--
-- 中身が SQL になるもの（__*_COND__ と __SRC_*__）を最後に置くのは、
-- 置き換えた中身がさらに走査されないようにするため。
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
  >,
  sources STRUCT<
    schemata    STRING,
    views       STRING,
    columns     STRING,
    field_paths STRING,
    table_opts  STRING
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
    '__VIEW_NAME_COND__', conditions.view_name_condition),
    '__SRC_SCHEMATA__', sources.schemata),
    '__SRC_VIEWS__', sources.views),
    '__SRC_COLUMNS__', sources.columns),
    '__SRC_FIELD_PATHS__', sources.field_paths),
    '__SRC_TABLE_OPTS__', sources.table_opts)
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
