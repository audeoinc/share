-- =====================================================================
-- suffix 違い View のロジック グループ比較の UDF を作る
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    再生成: node looker_studio/view_groups/build_udf.mjs
--    本体は esbuild で最小化してある（インラインのコード ブロブは
--    32 KB までに制限されるため。素の連結は約 48 KB で確実に弾かれる）。
--
-- 作る関数は 4 つ。名前はすべて CONFIGURATION の値から組み立てる。
--   viewlgc_analyze             View 群を解析して JSON を返す（JavaScript）
--   viewlgc_render              その JSON を比較 HTML にする（JavaScript）
--   viewlgc_group_css           テンプレートに貼る CSS を返す（JavaScript）
--   viewlgc_render_dynamic_sql  build_table.sql の __…__ を展開する（SQL）
--
-- 解析と描画を分けてあるのは、インラインのコード ブロブが 1 個あたり 32 KB
-- までのため。JS UDF の中から別の UDF は呼べないので、つなぐのは呼び出し側
-- の SQL（build_table.sql が analyze を 1 回呼び、その結果を render に渡す）。
--
-- 命名と設定の書き方は lineage プロジェクト（lineage/sql/setup/
-- 01_setup_lineage_environment.sql）にそろえてある。
--   UDF 名: udf_name_prefix + 'viewlgc_' + 基本名 + udf_name_suffix
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
--   udf_dataset
--     3 つの関数を作るデータセット。build_table.sql の同名の変数と合わせること。
--   udf_name_prefix / udf_name_suffix
--     関数名は udf_name_prefix + 'viewlgc_' + 基本名 + udf_name_suffix で
--     組み立てる。'viewlgc_' はこのシステムの識別子なのでリテラルのまま。
--     ルーチン名は英数字と '_' しか使えない（'-' は不可）ので、テーブル側の
--     prefix / suffix とは別に持つ。build_table.sql の同名の変数と合わせること。

-- [B] 既定のままで動くもの --------------------------------------------
-- 関数名（[C] で組み立てる）。基本名はリテラルで、変えるならここではなく
-- 下の SET を直す。build_table.sql の同名の変数と必ず同じ値にすること。
DECLARE udf_analyze_function_name STRING;
DECLARE udf_render_function_name  STRING;
DECLARE udf_css_function_name     STRING;
DECLARE udf_sql_function_name     STRING;

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
var E=Object.defineProperty,S=Object.defineProperties;var k=Object.getOwnPropertyDescriptors;var d=Object.getOwnPropertySymbols;var T=Object.prototype.hasOwnProperty,A=Object.prototype.propertyIsEnumerable;var g=(e,t,s)=>t in e?E(e,t,{enumerable:!0,configurable:!0,writable:!0,value:s}):e[t]=s,x=(e,t)=>{for(var s in t||(t={}))T.call(t,s)&&g(e,s,t[s]);if(d)for(var s of d(t))A.call(t,s)&&g(e,s,t[s]);return e},m=(e,t)=>S(e,k(t));const TOKEN_RE=new RegExp(["(`[^`]*`)","('(?:\\\\.|[^'\\\\])*')",'("(?:\\\\.|[^"\\\\])*")',"(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(\\d+(?:\\.\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],s=String(e==null?"":e);let u;for(TOKEN_RE.lastIndex=0;(u=TOKEN_RE.exec(s))!==null;){let i;u[1]?i="quoted":u[2]||u[3]?i="string":u[4]||u[5]?i="comment":u[6]?i="number":u[7]?i=KEYWORDS.has(u[7].toUpperCase())?"keyword":"ident":u[8]?i="space":i="punct",t.push({kind:i,text:u[0]})}return t}function stripOptionsClause(e){const t=[];let s=0;for(;s<e.length;){const u=e[s];if(u.kind==="keyword"&&u.text.toUpperCase()==="OPTIONS"){let i=s+1;for(;i<e.length&&e[i].kind==="space";)i++;if(i<e.length&&e[i].text==="("){let o=0,n=i;for(;n<e.length;n++)if(e[n].text==="(")o++;else if(e[n].text===")"&&(o--,o===0)){n++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();s=n;continue}}t.push(u),s++}return t}function markEntities(e){const t=e.slice(),s=o=>{let n=o+1;for(;n<t.length&&t[n].kind==="space";)n++;return n},u=[];let i=null;for(let o=0;o<t.length;o++){const n=t[o];if(n.kind==="space"||n.kind==="comment")continue;if(n.text==="("){u.push(i),i=null;continue}if(n.text===")"){u.pop(),i=null;continue}const r=n.text.toUpperCase();if(i=n.kind==="keyword"||n.kind==="ident"?r:null,n.kind!=="keyword"||r!=="FROM"&&r!=="JOIN"||u.length>0&&u[u.length-1]==="EXTRACT")continue;let f=s(o);for(;!(f>=t.length);){const l=t[f];if(l.kind==="quoted")t[f]={kind:"entity",text:l.text},f=s(f);else if(l.kind==="ident"){const a=s(f);if(a<t.length&&t[a].text==="(")break;let c=f;for(;;){t[c]={kind:"entity",text:t[c].text};const h=s(c);if(h<t.length&&t[h].text==="."){const p=s(h);if(p<t.length&&t[p].kind==="ident"){c=p;continue}}break}f=s(c)}else break;if(f<t.length&&t[f].text===","){f=s(f);continue}break}}return t}function normalizeSpace(e){return e.map(t=>t.kind==="space"?{kind:"space",text:" "}:t)}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/;function expandSuffixParts(e){let t=[""];for(const s of e){const u=[];for(const i of t)for(const o of s)u.push(i+o);t=u}return t.sort((s,u)=>u.length-s.length||s.localeCompare(u))}function extractSuffix(e,t){const s=t||{};if(Array.isArray(s.suffixParts)&&s.suffixParts.length>0){const o=s._expanded||(s._expanded=expandSuffixParts(s.suffixParts));for(const n of o)if(e.length>n.length+1&&e.endsWith("_"+n)){const r=[];let f=n;for(const l of s.suffixParts){const a=l.find(c=>f.startsWith(c));if(a===void 0){r.length=0;break}r.push(a),f=f.slice(a.length)}return{base:e.slice(0,-(n.length+1)),suffix:n,parts:r.length?r:void 0}}return null}if(Array.isArray(s.suffixList)&&s.suffixList.length>0){for(const o of s.suffixList)if(e.length>o.length+1&&e.endsWith("_"+o))return{base:e.slice(0,-(o.length+1)),suffix:o};return null}const u=s.suffixPattern?new RegExp(s.suffixPattern):DEFAULT_SUFFIX_RE,i=String(e).match(u);return i?{base:i[1],suffix:i[2]}:null}const DEFAULT_SUBSTITUTABLE=["entity","number","string"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001";function suffixWords(e,t){const s=String(e||"");if(s.length<2)return[];const u=[s];if(Array.isArray(t)&&t.length>0)for(const n of t)String(n).length>=2&&u.push(String(n));else s.length%2===0&&u.push(s.slice(0,s.length/2),s.slice(s.length/2));const i={},o=[];for(const n of u){const r=n.toLowerCase();i[r]||(i[r]=1,o.push(r))}return o}function buildLiteralMap(e){if(!Array.isArray(e)||e.length===0)return null;const t=typeof e[0]=="string"?[e]:e,s={};let u=0;for(let i=0;i<t.length;i++){if(!Array.isArray(t[i]))continue;const o=LITERAL_MARK+(i+1)+LITERAL_MARK;for(const n of t[i]){const r=String(n==null?"":n).toLowerCase();r&&(s[r]=o,u++)}}return u>0?s:null}function parseEquivalents(e){const t=e||{},s=t.equivalentLiterals;if(Array.isArray(s)){let u=!1;const i=[],o=[];for(const n of s)Array.isArray(n)?i.push(n):String(n).toLowerCase()==="suffix"?u=!0:n!=null&&o.push(n);return i.length===0&&o.length>0&&i.push(o),{useWords:u,groups:i.length>0?i:null}}return{useWords:t.literalSuffixWords!==!1,groups:Array.isArray(t.literalGroups)?t.literalGroups:null}}function maskTokens(e,t,s,u){const i=String(t||""),o=i.length>=2,n=parseEquivalents(u),r=o&&n.useWords?suffixWords(i,s):[],f=buildLiteralMap(n.groups);return!o&&r.length===0&&!f?e:e.map(l=>{if(l.kind==="space")return l;let a=l.text;if(o&&a.indexOf(i)>=0&&(a=a.split(i).join(SUFFIX_MARK)),r.length>0||f){const c=l.kind==="string"&&a.length>=2?a.slice(1,-1):l.kind==="number"?a:null;if(c){const h=c.toLowerCase(),p=r.indexOf(h)>=0?SUFFIX_MARK:f&&f[h];p&&(a=l.kind==="string"?a[0]+p+a[0]:p)}}return a===l.text?l:{kind:l.kind,text:a}})}function alphaMapDetail(e,t,s){if(e.length!==t.length)return{ok:!1,reason:"length",aLen:e.length,bLen:t.length};const u=new Set(s&&s.substitutable||DEFAULT_SUBSTITUTABLE),i=new Map,o=new Map;for(let n=0;n<e.length;n++){const r=e[n],f=t[n],l=a=>({ok:!1,reason:a,index:n,kind:r.kind,otherKind:f.kind,aText:r.text,bText:f.text});if(r.kind!==f.kind)return l("kind");if(r.text!==f.text){if(!u.has(r.kind))return l("not-substitutable");if(i.has(r.text)&&i.get(r.text)!==f.text)return l("inconsistent");if(o.has(f.text)&&o.get(f.text)!==r.text)return l("not-injective");i.set(r.text,f.text),o.set(f.text,r.text)}}return{ok:!0,fwd:i,rev:o}}function parameterize(e){const t=e[0].tokens.length,s=new Map,u=[],i=[];for(let o=0;o<t;o++){if(e[0].tokens[o].kind==="space"){i.push(e[0].raw[o].text);continue}const n=e.map(l=>l.raw[o].text);let r=!0;for(let l=1;l<n.length;l++)if(n[l]!==n[0]){r=!1;break}if(r){i.push(n[0]);continue}const f=JSON.stringify(n);if(!s.has(f)){const l="P"+(u.length+1);s.set(f,l);const a={};e.forEach((c,h)=>{a[c.suffix]=n[h]}),u.push({name:l,kind:e[0].raw[o].kind,values:a})}i.push("{{"+s.get(f)+"}}")}return{sql:i.join(""),params:u}}function groupByLogic(e,t){const s=!(t&&t.stripOptions===!1),u=!(t&&t.suffixAware===!1),i=e.map(n=>{let r=tokenizeSql(n.ddl);s&&(r=stripOptionsClause(r)),r=markEntities(r);const f=normalizeSpace(r);return m(x({},n),{raw:r,tokens:maskTokens(f,u?n.suffix:null,n.parts,t)})}),o=[];for(const n of i){let r=null,f=null;for(const l of o){const a=alphaMapDetail(l.members[0].tokens,n.tokens,t);if(a.ok){r=l;break}f||(f={vs:l.members[0].suffix,detail:a})}r?r.members.push(n):o.push({members:[n],miss:f})}return o.sort((n,r)=>r.members.length-n.members.length||String(n.members[0].suffix).localeCompare(String(r.members[0].suffix))),o.map(n=>{const r=n.members.slice().sort((l,a)=>String(l.suffix).localeCompare(String(a.suffix))),f=parameterize(r);return{suffixes:r.map(l=>l.suffix),members:r,sql:f.sql,params:f.params,miss:n.miss||null}})}function analyze(e,t){const s=!(t&&t.includeUnmatched===!1),u=new Map,i=[];for(const n of e){const r=extractSuffix(n.view_name,t);if(!r){i.push(n);continue}u.has(r.base)||u.set(r.base,[]),u.get(r.base).push({viewName:n.view_name,suffix:r.suffix,parts:r.parts,ddl:n.ddl})}const o=[];for(const[n,r]of u){const f=groupByLogic(r,t);o.push({base:n,viewCount:r.length,groupCount:f.length,groups:f})}if(s)for(const n of i){const r=[{viewName:n.view_name,suffix:null,parts:null,ddl:n.ddl}];o.push({base:n.view_name,viewCount:1,groupCount:1,groups:groupByLogic(r,t),unmatched:!0})}return o.sort((n,r)=>r.groupCount-n.groupCount||n.base.localeCompare(r.base)),{bases:o,unmatched:i}}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __trimBase(e){for(var t=[],s=0;s<e.groups.length;s++){for(var u=e.groups[s],i=[],o=0;o<u.members.length;o++)i.push({viewName:u.members[o].viewName});t.push({suffixes:u.suffixes,members:i,sql:u.sql,params:u.params,miss:u.miss})}return{base:e.base,viewCount:e.viewCount,groupCount:e.groupCount,unmatched:e.unmatched,groups:t}}function __label(e){for(var t=[],s=0;s<e.suffixes.length;s++)t.push(e.suffixes[s]||e.members[s]&&e.members[s].viewName||"(suffix \u306A\u3057)");return t.join(", ")}function __payload(e){return{viewCount:0,groupCount:0,groupLabels:[],groupSizes:[],suffixes:[],unmatchedCount:0,bases:[],lead:e||"",tail:""}}function __run(e,t){var s=__opts(t);if(!e||e.length===0)return JSON.stringify(__payload("View \u304C\u6E21\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002"));for(var u=[],i=0;i<e.length;i++)e[i]&&u.push({view_name:e[i].view_name,ddl:e[i].ddl});var o=analyze(u,s);if(o.bases.length===0){var n=__payload(u.length+" \u4EF6\u3059\u3079\u3066 suffix \u3092\u8A8D\u8B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002suffixParts / suffixList / suffixPattern \u306E\u6307\u5B9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return n.unmatchedCount=o.unmatched.length,JSON.stringify(n)}for(var r=__payload(""),f=0;f<o.bases.length;f++){var l=o.bases[f];r.bases.push(__trimBase(l)),r.viewCount+=l.viewCount,r.groupCount+=l.groupCount;for(var a=0;a<l.groups.length;a++){var c=l.groups[a];r.groupLabels.push(__label(c)),r.groupSizes.push(c.members.length);for(var h=0;h<c.suffixes.length;h++)r.suffixes.push(c.suffixes[h]||c.members[h].viewName)}}return r.suffixes.sort(),r.unmatchedCount=o.unmatched.length,o.unmatched.length>0&&s.includeUnmatched===!1&&(r.tail="suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u304C "+o.unmatched.length+" \u4EF6\u3042\u308A\u307E\u3059\u3002"),JSON.stringify(r)}return __run(views,options_json);

""";

DECLARE js_render STRING DEFAULT r"""
var b=Object.defineProperty;var f=Object.getOwnPropertySymbols;var x=Object.prototype.hasOwnProperty,m=Object.prototype.propertyIsEnumerable;var h=(e,t,n)=>t in e?b(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,u=(e,t)=>{for(var n in t||(t={}))x.call(t,n)&&h(e,n,t[n]);if(f)for(var n of f(t))m.call(t,n)&&h(e,n,t[n]);return e};function diffLines(e,t){const n=e.length,s=t.length,o=[];for(let i=0;i<=n;i++)o.push(new Int32Array(s+1));for(let i=n-1;i>=0;i--)for(let p=s-1;p>=0;p--)o[i][p]=e[i]===t[p]?o[i+1][p+1]+1:Math.max(o[i+1][p],o[i][p+1]);const r=[];let a=0,l=0;for(;a<n&&l<s;)e[a]===t[l]?(r.push({type:"equal",aIndex:a,bIndex:l,text:e[a]}),a++,l++):o[a+1][l]>=o[a][l+1]?(r.push({type:"del",aIndex:a,text:e[a]}),a++):(r.push({type:"add",bIndex:l,text:t[l]}),l++);for(;a<n;)r.push({type:"del",aIndex:a,text:e[a]}),a++;for(;l<s;)r.push({type:"add",bIndex:l,text:t[l]}),l++;return r}function lcsMatchFlags(e,t){const n=e.length,s=t.length,o=[];for(let i=0;i<=n;i++)o.push(new Int32Array(s+1));for(let i=n-1;i>=0;i--)for(let p=s-1;p>=0;p--)o[i][p]=e[i]===t[p]?o[i+1][p+1]+1:Math.max(o[i+1][p],o[i][p+1]);const r=new Array(n).fill(!1);let a=0,l=0;for(;a<n&&l<s;)e[a]===t[l]?(r[a]=!0,a++,l++):o[a+1][l]>=o[a][l+1]?a++:l++;return r}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const t=[];for(const n of e){const s=t[t.length-1];s&&s.hi===n.hi?s.text+=n.text:t.push({text:n.text,hi:n.hi})}return t}function segDiff(e,t){const n=e.length,s=t.length,o=[];for(let p=0;p<=n;p++)o.push(new Int32Array(s+1));for(let p=n-1;p>=0;p--)for(let d=s-1;d>=0;d--)o[p][d]=e[p]===t[d]?o[p+1][d+1]+1:Math.max(o[p+1][d],o[p][d+1]);const r=[],a=[];let l=0,i=0;for(;l<n&&i<s;)e[l]===t[i]?(r.push({text:e[l],hi:!1}),a.push({text:t[i],hi:!1}),l++,i++):o[l+1][i]>=o[l][i+1]?(r.push({text:e[l],hi:!0}),l++):(a.push({text:t[i],hi:!0}),i++);for(;l<n;)r.push({text:e[l],hi:!0}),l++;for(;i<s;)a.push({text:t[i],hi:!0}),i++;return{oldSegs:mergeSegs(r),newSegs:mergeSegs(a)}}function wordDiff(e,t){return segDiff(tokenize(e),tokenize(t))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(i=>[{text:String(i),hi:!1}]);if(e.length===2){const i=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[i.oldSegs,i.newSegs]}const t=tokenizeName(e[0]),n=tokenizeName(e[1]),s=tokenizeName(e[2]),o=segDiff(t,n).newSegs,r=segDiff(t,s).newSegs,a=new Array(t.length).fill(!0);for(const i of[n,s]){const p=lcsMatchFlags(t,i);for(let d=0;d<t.length;d++)a[d]=a[d]&&p[d]}return[mergeSegs(t.map((i,p)=>({text:i,hi:!a[p]}))),o,r]}function build2Way(e,t){const n=diffLines(e,t),s=[];let o=0;for(;o<n.length;){if(n[o].type==="equal"){const i=n[o];s.push({type:"equal",left:{num:i.aIndex+1,segs:[{text:i.text,hi:!1}],kind:"plain"},right:{num:i.bIndex+1,segs:[{text:i.text,hi:!1}],kind:"plain"}}),o++;continue}const r=[];for(;o<n.length&&n[o].type==="del";)r.push(n[o++]);const a=[];for(;o<n.length&&n[o].type==="add";)a.push(n[o++]);const l=Math.max(r.length,a.length);for(let i=0;i<l;i++){const p=r[i],d=a[i];if(p&&d){const c=wordDiff(p.text,d.text);s.push({type:"mod",left:{num:p.aIndex+1,segs:c.oldSegs,kind:"del"},right:{num:d.bIndex+1,segs:c.newSegs,kind:"add"}})}else p?s.push({type:"del",left:{num:p.aIndex+1,segs:[{text:p.text,hi:!1}],kind:"del"},right:null}):s.push({type:"add",left:null,right:{num:d.bIndex+1,segs:[{text:d.text,hi:!1}],kind:"add"}})}}return s}function splitLines(e){const t=String(e).split(/\r\n|\r|\n/);return t.length>1&&t[t.length-1]===""&&t.pop(),t}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=u({},DEFAULTS.T),PANES,S=u({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(n=>n+n).join(""));const t=parseInt(e,16);return[t>>16&255,t>>8&255,t&255]}function toHex(e,t,n){const s=o=>("0"+Math.round(Math.max(0,Math.min(255,o))).toString(16)).slice(-2);return"#"+s(e)+s(t)+s(n)}function mixWhite(e,t){const[n,s,o]=hexToRgb(e),r=a=>255+(a-255)*t;return toHex(r(n),r(s),r(o))}function darken(e,t){const[n,s,o]=hexToRgb(e),r=a=>a*(1-t);return toHex(r(n),r(s),r(o))}function buildPane(e,t,n){return{bg:mixWhite(e,t),hi:mixWhite(e,n),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=u({},DEFAULTS.T),S=u({},DEFAULTS.S);const t=u({},DEFAULTS.paneColors);let n=DEFAULTS.lineOpacity,s=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const o=e.colors||{};HEX.test(o.baseColor||"")&&(t.base=o.baseColor),HEX.test(o.afterColor||"")&&(t.after=o.afterColor),HEX.test(o.refColor||"")&&(t.ref=o.refColor),isNum(e.diffLineOpacity)&&(n=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(s=e.diffCharOpacity);const r=e.syntax||{};r.keyword&&(S.keyword=r.keyword),r.literal&&(S.literal=r.literal),r.comment&&(S.comment=r.comment)}PANES={base:buildPane(t.base,n,s),after:buildPane(t.after,n,s),ref:buildPane(t.ref,n,s)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function sqlHighlight(e){const t=e.length;let n=0,s="";const o=(d,c,g)=>`<span style="color:${d};${g?"font-style:italic;":""}">${esc(c)}</span>`,r=d=>d===" "||d==="	",a=d=>d>="0"&&d<="9",l=d=>/[A-Za-z_]/.test(d),i=d=>/[A-Za-z0-9_]/.test(d),p=d=>"=<>!+-*/%|,.();:".indexOf(d)>=0;for(;n<t;){const d=e[n];if(r(d)){let c=n+1;for(;c<t&&r(e[c]);)c++;s+=esc(e.slice(n,c)),n=c;continue}if(d==="-"&&e[n+1]==="-"){s+=o(S.comment,e.slice(n),!0);break}if(d==="'"){let c=n+1;for(;c<t;){if(e[c]==="'"){if(e[c+1]==="'"){c+=2;continue}c++;break}c++}s+=o(S.literal,e.slice(n,c)),n=c;continue}if(a(d)){let c=n+1;for(;c<t&&(a(e[c])||e[c]===".");)c++;s+=o(S.literal,e.slice(n,c)),n=c;continue}if(l(d)){let c=n+1;for(;c<t&&i(e[c]);)c++;const g=e.slice(n,c);SQL_KEYWORDS.has(g.toUpperCase())?s+=o(S.keyword,g):s+=esc(g),n=c;continue}s+=esc(d),n++}return s}function renderSegs(e,t){if(!e||!e.length)return"&nbsp;";let n="";for(const s of e){const o=sqlHighlight(s.text);n+=s.hi?`<span style="background:${t};border-radius:2px;">${o}</span>`:o}return n===""?"&nbsp;":n}function numTd(e,t,n){const s=n?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${t.numBg};border-right:1px solid ${T.numBorder};${s}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,t){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${t.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${t.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,t,n){let s=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(s+=`background:${n.bg};border-left:2px solid ${n.bar};`),`<td style="${s}">${t||"&nbsp;"}</td>`}function hatchTd(e,t){const n=t?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${n}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${n}${T.hatch}">&nbsp;</td>`}function labelHtml(e,t){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(n=>n.hi?`<span style="background:${t.hi};border-radius:2px;">${esc(n.text)}</span>`:esc(n.text)).join("")}function th(e,t,n,s,o){const r=o?`border-left:1px solid ${T.border};`:"",a=n?`&nbsp;<span style="color:${s.headText};font-weight:400;">(${esc(n)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${s.headBg};border-bottom:2px solid ${s.bar};${r}padding:7px 12px;">${labelHtml(t,s)}${a}</th>`}function wrapTable(e,t,n){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:hidden;font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${t}</tr></thead>
    <tbody>
${n}    </tbody>
  </table>
</div>
`}function renderFragment1(e,t,n,s){configure(s);const o='<colgroup><col style="width:40px"><col></colgroup>',r=th(2,e,t,PANES.base,!1);let a="";for(let l=0;l<n.length;l++)a+=`      <tr>${numTd(l+1,PANES.base,!1)}${codeTd("same",sqlHighlight(n[l]),PANES.base)}</tr>
`;return wrapTable(o,r,a)}function renderFragment2(e,t,n,s){configure(s);const o='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',r=nameDiff([e,t]),a=th(3,r[0],"before",PANES.base,!1)+th(3,r[1],"after",PANES.after,!0);let l="";for(const i of n){const p=i.left,d=i.right;let c="";p?c+=numTd(p.num,PANES.base,!1)+markTd(p.kind==="del"?"del":"blank",PANES.base)+codeTd(p.kind,renderSegs(p.segs,PANES.base.hi),PANES.base):c+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),d?c+=numTd(d.num,PANES.after,!0)+markTd(d.kind==="add"?"add":"blank",PANES.after)+codeTd(d.kind,renderSegs(d.segs,PANES.after.hi),PANES.after):c+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),l+=`      <tr>${c}</tr>
`}return wrapTable(o,a,l)}const MAX_TABS=12;function esc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(e){let t=2166136261;for(let n=0;n<String(e).length;n++)t^=String(e).charCodeAt(n),t=Math.imul(t,16777619)>>>0;return t.toString(36)}const label=e=>e.suffixes.map((t,n)=>t||e.members[n]&&e.members[n].viewName||"(suffix \u306A\u3057)").join(", ");function relabelPanes(e,t){let n=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(s,o,r)=>{const a=t[n++];return a==null?s:o+esc(a)+r})}const paneSub=e=>`${e.members.length} View`;function badge(e,t,n){return`<span class="vg-badge" style="color:${t};background:${n}">${esc(e)}</span>`}function header(e,t,n,s){const o=n>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${t} View`,"#57606A","#EAEEF2")+badge(`${n} \u30B0\u30EB\u30FC\u30D7`,o?"#9A6700":"#1A7F37",o?"#FFF8C5":"#DAFBE1")+(s?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e,REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u3067\u304D\u306A\u3044\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u5217\u540D\u30FB\u5225\u540D\u30FBCTE \u540D\u30FB\u4E88\u7D04\u8A9E\u306A\u3069\u3002\u7F6E\u63DB\u3057\u3066\u3088\u3044\u306E\u306F FROM / JOIN \u306E\u5B9F\u4F53\u540D\u3068\u5024\u3060\u3051\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e){const t=r=>String(r==null?"":r).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),n=e.filter(r=>r.miss).map(r=>{const a=r.miss.detail,l=a.reason==="length"?`${a.aLen} \u5BFE ${a.bLen}`:`<code class="vg-mcode">${esc(t(a.aText))}</code> \u2194 <code class="vg-mcode">${esc(t(a.bText))}</code><span class="vg-mkind">${esc(kindText(a.kind))}</span>`;return`<tr><th class="vg-mname">${esc(label(r))}</th><td class="vg-mvs">vs ${esc(r.miss.vs)}</td><td class="vg-mreason">${esc(REASON_TEXT[a.reason]||a.reason)}<br>${l}</td></tr>`}).join("");return n?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(r=>r.miss&&r.miss.detail.reason==="not-substitutable"&&(r.miss.detail.kind==="string"||r.miss.detail.kind==="number"))?'<div class="vg-mhint">\u5024\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u3067\u306F\u5024\u306F\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u3066\u540C\u3058\u30B0\u30EB\u30FC\u30D7\u306B\u3059\u308B\u306E\u3067\u3001<code class="vg-mcode">substitutable</code> \u3092\u7D5E\u3063\u305F\u8A2D\u5B9A\u306B\u306A\u3063\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u306B\u623B\u3059\u306A\u3089 options_json \u304B\u3089 <code class="vg-mcode">"substitutable"</code> \u3092\u5916\u3057\u307E\u3059\u3002<br>\u7D5E\u3063\u305F\u307E\u307E\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>':""}<div class="vg-pblock"><table class="vg-ptable">${n}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(n=>{if(!n.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(n))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const s=n.params.map(o=>{const r=Object.entries(o.values).map(([l,i])=>`<div class="vg-pv"><span class="vg-psuf">${esc(l)}</span>${esc(i)}</div>`).join(""),a=`<span class="vg-mkind">${esc(kindText(o.kind))}</span>`;return`<tr><th class="vg-pname">${esc(o.name)}</th><td class="vg-pvals">${a}${r}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(n))}</div><table class="vg-ptable">${s}</table></div>`}).join("")}</details>`}function pair(e,t,n){return relabelPanes(renderFragment2(label(e),label(t),build2Way(splitLines(e.sql),splitLines(t.sql)),n),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(t)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,t,n){const[s,...o]=e,r=o.slice(0,MAX_TABS),a=r.map((d,c)=>`<input class="vg-r vg-r${c+1}" type="radio" name="${n}" id="${n}-${c+1}"${c===0?" checked":""}>`).join(""),l=baseTab(s)+r.map((d,c)=>`<label class="vg-tab vg-t${c+1}" for="${n}-${c+1}">${esc(label(d))}<span class="vg-tabn">${d.members.length}</span></label>`).join(""),i=r.length?r.map((d,c)=>`<div class="vg-panel vg-p${c+1}">${pair(s,d,t)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(s),paneSub(s),splitLines(s.sql),t)}</div>`;return(o.length>r.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D ${MAX_TABS} \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${o.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${a}<div class="vg-tablist">${l}</div><div class="vg-panels">${i}</div></div>`}function renderBase(e,t){const n=t||{},s=e.groups,o=s.length,r="vgt"+hashId(e.base+"|"+s.map(label).join("|"));let a;return o===0?a=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):a=(o>1?"":notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`))+tabs(s,n,r),'<div class="vg-root">'+header(e.base,e.viewCount,o,e.unmatched)+a+missTable(s)+paramsTable(s)+"</div>"}function chromeCss(){const e=[".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font:600 15px/1.6 inherit;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font:600 12px/1.8 inherit;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font:600 12px/1.6 inherit;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}"];for(let t=1;t<=MAX_TABS;t++)e.push(`.vg-r${t}:checked ~ .vg-panels > .vg-p${t}{display:block}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t}{background:#fff;border-color:#D0D7DE;color:#24292F}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t} .vg-tabn{background:#DDF4FF;color:#0969DA}`);return e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var t=2166136261,n=0;n<e.length;n++)t^=e.charCodeAt(n),t=Math.imul(t,16777619)>>>0;return"d"+t.toString(36)}function __split(e){var t={},n=e.replace(/ style="([^"]*)"/g,function(s,o){var r=__hashClass(o);return t[r]=o,' class="'+r+'"'});return{markup:n,rules:t}}function __rulesToCss(e){for(var t=Object.keys(e).sort(),n=[],s=0;s<t.length;s++)n.push("."+t[s]+"{"+e[t[s]]+"}");return n.join(`
`)}function __applyMode(e,t){if(t==="class")return __split(e).markup;if(t==="embed"){var n=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(n.rules)+`
</style>
`+n.markup}return e}function __run(e,t){var n=__opts(t),s;try{s=JSON.parse(e)}catch(l){s=null}if(!s)return __notice("\u89E3\u6790\u7D50\u679C\u3092\u8AAD\u307F\u53D6\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002");for(var o=s.lead?__notice(s.lead):"",r=s.bases||[],a=0;a<r.length;a++)o+=renderBase(r[a],n);return s.tail&&(o+=__notice(s.tail)),__applyMode(o,n.mode||"inline")}return __run(analysis_json,options_json);

""";

DECLARE js_css STRING DEFAULT r"""
var v=Object.defineProperty;var x=Object.getOwnPropertySymbols;var E=Object.prototype.hasOwnProperty,$=Object.prototype.propertyIsEnumerable;var m=(e,n,t)=>n in e?v(e,n,{enumerable:!0,configurable:!0,writable:!0,value:t}):e[n]=t,g=(e,n)=>{for(var t in n||(n={}))E.call(n,t)&&m(e,t,n[t]);if(x)for(var t of x(n))$.call(n,t)&&m(e,t,n[t]);return e};function diffLines(e,n){const t=e.length,s=n.length,r=[];for(let i=0;i<=t;i++)r.push(new Int32Array(s+1));for(let i=t-1;i>=0;i--)for(let p=s-1;p>=0;p--)r[i][p]=e[i]===n[p]?r[i+1][p+1]+1:Math.max(r[i+1][p],r[i][p+1]);const o=[];let a=0,c=0;for(;a<t&&c<s;)e[a]===n[c]?(o.push({type:"equal",aIndex:a,bIndex:c,text:e[a]}),a++,c++):r[a+1][c]>=r[a][c+1]?(o.push({type:"del",aIndex:a,text:e[a]}),a++):(o.push({type:"add",bIndex:c,text:n[c]}),c++);for(;a<t;)o.push({type:"del",aIndex:a,text:e[a]}),a++;for(;c<s;)o.push({type:"add",bIndex:c,text:n[c]}),c++;return o}function lcsMatchFlags(e,n){const t=e.length,s=n.length,r=[];for(let i=0;i<=t;i++)r.push(new Int32Array(s+1));for(let i=t-1;i>=0;i--)for(let p=s-1;p>=0;p--)r[i][p]=e[i]===n[p]?r[i+1][p+1]+1:Math.max(r[i+1][p],r[i][p+1]);const o=new Array(t).fill(!1);let a=0,c=0;for(;a<t&&c<s;)e[a]===n[c]?(o[a]=!0,a++,c++):r[a+1][c]>=r[a][c+1]?a++:c++;return o}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const n=[];for(const t of e){const s=n[n.length-1];s&&s.hi===t.hi?s.text+=t.text:n.push({text:t.text,hi:t.hi})}return n}function segDiff(e,n){const t=e.length,s=n.length,r=[];for(let p=0;p<=t;p++)r.push(new Int32Array(s+1));for(let p=t-1;p>=0;p--)for(let l=s-1;l>=0;l--)r[p][l]=e[p]===n[l]?r[p+1][l+1]+1:Math.max(r[p+1][l],r[p][l+1]);const o=[],a=[];let c=0,i=0;for(;c<t&&i<s;)e[c]===n[i]?(o.push({text:e[c],hi:!1}),a.push({text:n[i],hi:!1}),c++,i++):r[c+1][i]>=r[c][i+1]?(o.push({text:e[c],hi:!0}),c++):(a.push({text:n[i],hi:!0}),i++);for(;c<t;)o.push({text:e[c],hi:!0}),c++;for(;i<s;)a.push({text:n[i],hi:!0}),i++;return{oldSegs:mergeSegs(o),newSegs:mergeSegs(a)}}function wordDiff(e,n){return segDiff(tokenize(e),tokenize(n))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(i=>[{text:String(i),hi:!1}]);if(e.length===2){const i=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[i.oldSegs,i.newSegs]}const n=tokenizeName(e[0]),t=tokenizeName(e[1]),s=tokenizeName(e[2]),r=segDiff(n,t).newSegs,o=segDiff(n,s).newSegs,a=new Array(n.length).fill(!0);for(const i of[t,s]){const p=lcsMatchFlags(n,i);for(let l=0;l<n.length;l++)a[l]=a[l]&&p[l]}return[mergeSegs(n.map((i,p)=>({text:i,hi:!a[p]}))),r,o]}function build2Way(e,n){const t=diffLines(e,n),s=[];let r=0;for(;r<t.length;){if(t[r].type==="equal"){const i=t[r];s.push({type:"equal",left:{num:i.aIndex+1,segs:[{text:i.text,hi:!1}],kind:"plain"},right:{num:i.bIndex+1,segs:[{text:i.text,hi:!1}],kind:"plain"}}),r++;continue}const o=[];for(;r<t.length&&t[r].type==="del";)o.push(t[r++]);const a=[];for(;r<t.length&&t[r].type==="add";)a.push(t[r++]);const c=Math.max(o.length,a.length);for(let i=0;i<c;i++){const p=o[i],l=a[i];if(p&&l){const d=wordDiff(p.text,l.text);s.push({type:"mod",left:{num:p.aIndex+1,segs:d.oldSegs,kind:"del"},right:{num:l.bIndex+1,segs:d.newSegs,kind:"add"}})}else p?s.push({type:"del",left:{num:p.aIndex+1,segs:[{text:p.text,hi:!1}],kind:"del"},right:null}):s.push({type:"add",left:null,right:{num:l.bIndex+1,segs:[{text:l.text,hi:!1}],kind:"add"}})}}return s}function splitLines(e){const n=String(e).split(/\r\n|\r|\n/);return n.length>1&&n[n.length-1]===""&&n.pop(),n}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=g({},DEFAULTS.T),PANES,S=g({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(t=>t+t).join(""));const n=parseInt(e,16);return[n>>16&255,n>>8&255,n&255]}function toHex(e,n,t){const s=r=>("0"+Math.round(Math.max(0,Math.min(255,r))).toString(16)).slice(-2);return"#"+s(e)+s(n)+s(t)}function mixWhite(e,n){const[t,s,r]=hexToRgb(e),o=a=>255+(a-255)*n;return toHex(o(t),o(s),o(r))}function darken(e,n){const[t,s,r]=hexToRgb(e),o=a=>a*(1-n);return toHex(o(t),o(s),o(r))}function buildPane(e,n,t){return{bg:mixWhite(e,n),hi:mixWhite(e,t),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=g({},DEFAULTS.T),S=g({},DEFAULTS.S);const n=g({},DEFAULTS.paneColors);let t=DEFAULTS.lineOpacity,s=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const r=e.colors||{};HEX.test(r.baseColor||"")&&(n.base=r.baseColor),HEX.test(r.afterColor||"")&&(n.after=r.afterColor),HEX.test(r.refColor||"")&&(n.ref=r.refColor),isNum(e.diffLineOpacity)&&(t=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(s=e.diffCharOpacity);const o=e.syntax||{};o.keyword&&(S.keyword=o.keyword),o.literal&&(S.literal=o.literal),o.comment&&(S.comment=o.comment)}PANES={base:buildPane(n.base,t,s),after:buildPane(n.after,t,s),ref:buildPane(n.ref,t,s)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function sqlHighlight(e){const n=e.length;let t=0,s="";const r=(l,d,u)=>`<span style="color:${l};${u?"font-style:italic;":""}">${esc(d)}</span>`,o=l=>l===" "||l==="	",a=l=>l>="0"&&l<="9",c=l=>/[A-Za-z_]/.test(l),i=l=>/[A-Za-z0-9_]/.test(l),p=l=>"=<>!+-*/%|,.();:".indexOf(l)>=0;for(;t<n;){const l=e[t];if(o(l)){let d=t+1;for(;d<n&&o(e[d]);)d++;s+=esc(e.slice(t,d)),t=d;continue}if(l==="-"&&e[t+1]==="-"){s+=r(S.comment,e.slice(t),!0);break}if(l==="'"){let d=t+1;for(;d<n;){if(e[d]==="'"){if(e[d+1]==="'"){d+=2;continue}d++;break}d++}s+=r(S.literal,e.slice(t,d)),t=d;continue}if(a(l)){let d=t+1;for(;d<n&&(a(e[d])||e[d]===".");)d++;s+=r(S.literal,e.slice(t,d)),t=d;continue}if(c(l)){let d=t+1;for(;d<n&&i(e[d]);)d++;const u=e.slice(t,d);SQL_KEYWORDS.has(u.toUpperCase())?s+=r(S.keyword,u):s+=esc(u),t=d;continue}s+=esc(l),t++}return s}function renderSegs(e,n){if(!e||!e.length)return"&nbsp;";let t="";for(const s of e){const r=sqlHighlight(s.text);t+=s.hi?`<span style="background:${n};border-radius:2px;">${r}</span>`:r}return t===""?"&nbsp;":t}function numTd(e,n,t){const s=t?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${n.numBg};border-right:1px solid ${T.numBorder};${s}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,n){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${n.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,n,t){let s=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(s+=`background:${t.bg};border-left:2px solid ${t.bar};`),`<td style="${s}">${n||"&nbsp;"}</td>`}function hatchTd(e,n){const t=n?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${t}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${t}${T.hatch}">&nbsp;</td>`}function labelHtml(e,n){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(t=>t.hi?`<span style="background:${n.hi};border-radius:2px;">${esc(t.text)}</span>`:esc(t.text)).join("")}function th(e,n,t,s,r){const o=r?`border-left:1px solid ${T.border};`:"",a=t?`&nbsp;<span style="color:${s.headText};font-weight:400;">(${esc(t)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${s.headBg};border-bottom:2px solid ${s.bar};${o}padding:7px 12px;">${labelHtml(n,s)}${a}</th>`}function wrapTable(e,n,t){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:hidden;font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${n}</tr></thead>
    <tbody>
${t}    </tbody>
  </table>
</div>
`}function renderFragment1(e,n,t,s){configure(s);const r='<colgroup><col style="width:40px"><col></colgroup>',o=th(2,e,n,PANES.base,!1);let a="";for(let c=0;c<t.length;c++)a+=`      <tr>${numTd(c+1,PANES.base,!1)}${codeTd("same",sqlHighlight(t[c]),PANES.base)}</tr>
`;return wrapTable(r,o,a)}function renderFragment2(e,n,t,s){configure(s);const r='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',o=nameDiff([e,n]),a=th(3,o[0],"before",PANES.base,!1)+th(3,o[1],"after",PANES.after,!0);let c="";for(const i of t){const p=i.left,l=i.right;let d="";p?d+=numTd(p.num,PANES.base,!1)+markTd(p.kind==="del"?"del":"blank",PANES.base)+codeTd(p.kind,renderSegs(p.segs,PANES.base.hi),PANES.base):d+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),l?d+=numTd(l.num,PANES.after,!0)+markTd(l.kind==="add"?"add":"blank",PANES.after)+codeTd(l.kind,renderSegs(l.segs,PANES.after.hi),PANES.after):d+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),c+=`      <tr>${d}</tr>
`}return wrapTable(r,a,c)}const MAX_TABS=12;function esc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(e){let n=2166136261;for(let t=0;t<String(e).length;t++)n^=String(e).charCodeAt(t),n=Math.imul(n,16777619)>>>0;return n.toString(36)}const label=e=>e.suffixes.map((n,t)=>n||e.members[t]&&e.members[t].viewName||"(suffix \u306A\u3057)").join(", ");function relabelPanes(e,n){let t=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(s,r,o)=>{const a=n[t++];return a==null?s:r+esc(a)+o})}const paneSub=e=>`${e.members.length} View`;function badge(e,n,t){return`<span class="vg-badge" style="color:${n};background:${t}">${esc(e)}</span>`}function header(e,n,t,s){const r=t>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${n} View`,"#57606A","#EAEEF2")+badge(`${t} \u30B0\u30EB\u30FC\u30D7`,r?"#9A6700":"#1A7F37",r?"#FFF8C5":"#DAFBE1")+(s?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const KIND_TEXT={entity:"\u5B9F\u4F53\u540D",string:"\u5024\uFF08\u6587\u5B57\u5217\uFF09",number:"\u5024\uFF08\u6570\u5024\uFF09",ident:"\u540D\u524D",quoted:"\u540D\u524D",keyword:"\u4E88\u7D04\u8A9E",punct:"\u8A18\u53F7",comment:"\u30B3\u30E1\u30F3\u30C8"},kindText=e=>KIND_TEXT[e]||e,REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u3067\u304D\u306A\u3044\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u5217\u540D\u30FB\u5225\u540D\u30FBCTE \u540D\u30FB\u4E88\u7D04\u8A9E\u306A\u3069\u3002\u7F6E\u63DB\u3057\u3066\u3088\u3044\u306E\u306F FROM / JOIN \u306E\u5B9F\u4F53\u540D\u3068\u5024\u3060\u3051\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e){const n=o=>String(o==null?"":o).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),t=e.filter(o=>o.miss).map(o=>{const a=o.miss.detail,c=a.reason==="length"?`${a.aLen} \u5BFE ${a.bLen}`:`<code class="vg-mcode">${esc(n(a.aText))}</code> \u2194 <code class="vg-mcode">${esc(n(a.bText))}</code><span class="vg-mkind">${esc(kindText(a.kind))}</span>`;return`<tr><th class="vg-mname">${esc(label(o))}</th><td class="vg-mvs">vs ${esc(o.miss.vs)}</td><td class="vg-mreason">${esc(REASON_TEXT[a.reason]||a.reason)}<br>${c}</td></tr>`}).join("");return t?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(o=>o.miss&&o.miss.detail.reason==="not-substitutable"&&(o.miss.detail.kind==="string"||o.miss.detail.kind==="number"))?'<div class="vg-mhint">\u5024\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u3067\u306F\u5024\u306F\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u3066\u540C\u3058\u30B0\u30EB\u30FC\u30D7\u306B\u3059\u308B\u306E\u3067\u3001<code class="vg-mcode">substitutable</code> \u3092\u7D5E\u3063\u305F\u8A2D\u5B9A\u306B\u306A\u3063\u3066\u3044\u307E\u3059\u3002\u65E2\u5B9A\u306B\u623B\u3059\u306A\u3089 options_json \u304B\u3089 <code class="vg-mcode">"substitutable"</code> \u3092\u5916\u3057\u307E\u3059\u3002<br>\u7D5E\u3063\u305F\u307E\u307E\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>':""}<div class="vg-pblock"><table class="vg-ptable">${t}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(t=>{if(!t.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const s=t.params.map(r=>{const o=Object.entries(r.values).map(([c,i])=>`<div class="vg-pv"><span class="vg-psuf">${esc(c)}</span>${esc(i)}</div>`).join(""),a=`<span class="vg-mkind">${esc(kindText(r.kind))}</span>`;return`<tr><th class="vg-pname">${esc(r.name)}</th><td class="vg-pvals">${a}${o}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(t))}</div><table class="vg-ptable">${s}</table></div>`}).join("")}</details>`}function pair(e,n,t){return relabelPanes(renderFragment2(label(e),label(n),build2Way(splitLines(e.sql),splitLines(n.sql)),t),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(n)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,n,t){const[s,...r]=e,o=r.slice(0,MAX_TABS),a=o.map((l,d)=>`<input class="vg-r vg-r${d+1}" type="radio" name="${t}" id="${t}-${d+1}"${d===0?" checked":""}>`).join(""),c=baseTab(s)+o.map((l,d)=>`<label class="vg-tab vg-t${d+1}" for="${t}-${d+1}">${esc(label(l))}<span class="vg-tabn">${l.members.length}</span></label>`).join(""),i=o.length?o.map((l,d)=>`<div class="vg-panel vg-p${d+1}">${pair(s,l,n)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(s),paneSub(s),splitLines(s.sql),n)}</div>`;return(r.length>o.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D ${MAX_TABS} \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${r.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${a}<div class="vg-tablist">${c}</div><div class="vg-panels">${i}</div></div>`}function renderBase(e,n){const t=n||{},s=e.groups,r=s.length,o="vgt"+hashId(e.base+"|"+s.map(label).join("|"));let a;return r===0?a=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):a=(r>1?"":notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`))+tabs(s,t,o),'<div class="vg-root">'+header(e.base,e.viewCount,r,e.unmatched)+a+missTable(s)+paramsTable(s)+"</div>"}function chromeCss(){const e=[".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font:600 15px/1.6 inherit;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font:600 12px/1.8 inherit;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font:600 12px/1.6 inherit;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}"];for(let n=1;n<=MAX_TABS;n++)e.push(`.vg-r${n}:checked ~ .vg-panels > .vg-p${n}{display:block}`),e.push(`.vg-r${n}:checked ~ .vg-tablist > .vg-t${n}{background:#fff;border-color:#D0D7DE;color:#24292F}`),e.push(`.vg-r${n}:checked ~ .vg-tablist > .vg-t${n} .vg-tabn{background:#DDF4FF;color:#0969DA}`);return e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(n){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var n=2166136261,t=0;t<e.length;t++)n^=e.charCodeAt(t),n=Math.imul(n,16777619)>>>0;return"d"+n.toString(36)}function __split(e){var n={},t=e.replace(/ style="([^"]*)"/g,function(s,r){var o=__hashClass(r);return n[o]=r,' class="'+o+'"'});return{markup:t,rules:n}}function __rulesToCss(e){for(var n=Object.keys(e).sort(),t=[],s=0;s<n.length;s++)t.push("."+n[s]+"{"+e[n[s]]+"}");return t.join(`
`)}function __applyMode(e,n){if(n==="class")return __split(e).markup;if(n==="embed"){var t=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(t.rules)+`
</style>
`+t.markup}return e}function __fixtureRules(e){var n={};function t(l){var d=__split(renderBase(l,e)).rules;for(var u in d)n[u]=d[u]}function s(l,d,u,b){for(var f=[],h=0;h<l.length;h++)f.push({viewName:"v_fixture_"+l[h]});return{suffixes:l,members:f,sql:d,params:u||[],miss:b}}function r(l,d,u){for(var b=0,f=0;f<d.length;f++)b+=d[f].members.length;return{base:l,viewCount:b,groupCount:d.length,unmatched:u,groups:d}}var o=`SELECT
  a,
  b
FROM t_{{P1}}
WHERE x = 1`,a=`SELECT
  a,
  c.b
FROM t_{{P1}}
LEFT JOIN u_{{P1}} AS c USING (a)
WHERE x = 2`,c=`SELECT
  a
FROM t_{{P1}}
WHERE x = 1`,i=[{name:"{{P1}}",values:{abjp:"t_abjp",abus:"t_abus"}}],p={vs:"abjp, abus",detail:{reason:"not-substitutable",kind:"string",aText:"'apac'",bText:"'amer'"}};return t(r("v_fixture_one",[s(["abjp","abus"],o,[])])),t(r("v_fixture_two",[s(["abjp","abus"],o,i),s(["cdjp"],a,i,p)])),t(r("v_fixture_many",[s(["abjp","abus"],o,i),s(["cdjp"],a,i,p),s(["efjp"],c,i,p)])),t(r("v_fixture_no_suffix",[{suffixes:[null],members:[{viewName:"v_fixture_no_suffix"}],sql:o,params:[]}],!0)),n}return chromeCss()+`
`+__rulesToCss(__fixtureRules(__opts(options_json)));

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

-- 関数名: udf_name_prefix + 'viewlgc_' + 基本名 + udf_name_suffix
SET udf_analyze_function_name =
  udf_name_prefix || 'viewlgc_' || 'analyze' || udf_name_suffix;
SET udf_render_function_name =
  udf_name_prefix || 'viewlgc_' || 'render' || udf_name_suffix;
SET udf_css_function_name =
  udf_name_prefix || 'viewlgc_' || 'group_css' || udf_name_suffix;
SET udf_sql_function_name =
  udf_name_prefix || 'viewlgc_' || 'render_dynamic_sql' || udf_name_suffix;
ASSERT REGEXP_CONTAINS(udf_analyze_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_analyze_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_render_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
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
-- 3. viewlgc_group_css
--    mode='class' のときテンプレートへ貼る CSS を返す
--
--   SELECT `<project>.<udf_dataset>.viewlgc_group_css`(NULL);
--
-- 結果を <style> … </style> で囲んで Templated Record のテンプレートに貼る。
-- 見出し・タブ・パラメータ表の規則と、差分表の規則の両方を含む。
-- タブの CSS は ID ではなくクラスで書いてあるので、レコードが変わっても
-- この CSS のまま使える。
--
-- options_json は group_info と同じものを渡すこと。色やフォントを
-- 変えた場合、CSS 側も同じ設定で作り直す必要がある。
-- ---------------------------------------------------------------------
EXECUTE IMMEDIATE FORMAT('''
CREATE OR REPLACE FUNCTION `%s.%s.%s`(options_json STRING)
RETURNS STRING
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_css_function_name,
  TO_JSON_STRING(js_css));


-- ---------------------------------------------------------------------
-- 4. viewlgc_render_dynamic_sql
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
--   __V_DIFF__             最新スナップショットのビュー（同上）
--   __UDF_ANALYZE__        analyze 関数（project.dataset.function）
--   __UDF_RENDER__         render 関数（同上）
--   __UDF_CSS__            group_css 関数（同上）
--   __TZ__                 snapshot_date の基準タイムゾーン
--   __RETENTION_DAYS__     パーティションの保持日数
--   __SUFFIX_PATTERN__     suffix を切り出す正規表現
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
    diff_hist        STRING,
    diff_latest      STRING,
    analyze_function STRING,
    render_function  STRING,
    css_function     STRING
  >,
  options STRUCT<
    time_zone      STRING,
    retention_days STRING,
    suffix_pattern STRING
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
    sql_template,
    '__TARGET_PROJECT__', target_project_id),
    '__JOB_REGION__', job_region),
    '__T_DIFF_HIST__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_hist),
    '__V_DIFF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_latest),
    '__UDF_ANALYZE__',
      udf_project_id || '.' || udf_dataset || '.' || objects.analyze_function),
    '__UDF_RENDER__',
      udf_project_id || '.' || udf_dataset || '.' || objects.render_function),
    '__UDF_CSS__',
      udf_project_id || '.' || udf_dataset || '.' || objects.css_function),
    '__TZ__', options.time_zone),
    '__RETENTION_DAYS__', options.retention_days),
    '__SUFFIX_PATTERN__', options.suffix_pattern),
    '__SCHEMA_COND__', conditions.schema_condition),
    '__VIEW_DATASET_COND__', conditions.view_dataset_condition),
    '__VIEW_NAME_COND__', conditions.view_name_condition)
)
''',
  udf_project_id, udf_dataset, udf_sql_function_name);


-- 作った 4 つの名前を出す。build_table.sql に同じ値を入れる。
SELECT
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_analyze_function_name) AS analyze_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_render_function_name)  AS render_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_css_function_name)     AS css_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_sql_function_name)     AS sql_function,
  CURRENT_TIMESTAMP() AS created_at;
END;
