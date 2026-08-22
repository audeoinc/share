-- =====================================================================
-- suffix 違い View のロジック グループ比較の UDF を作る
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    再生成: node looker_studio/view_groups/build_udf.mjs
--    本体は esbuild で最小化してある（インラインのコード ブロブは
--    32 KB までに制限されるため。素の連結は約 48 KB で確実に弾かれる）。
--
-- 作る関数は 3 つ。名前はすべて CONFIGURATION の値から組み立てる。
--   viewlgc_group_info          比較 HTML とメタデータを返す（JavaScript）
--   viewlgc_group_css           テンプレートに貼る CSS を返す（JavaScript）
--   viewlgc_render_dynamic_sql  build_table.sql の __…__ を展開する（SQL）
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
DECLARE udf_info_function_name   STRING;
DECLARE udf_css_function_name    STRING;
DECLARE udf_render_function_name STRING;

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
DECLARE js_info STRING DEFAULT r"""
var w=Object.defineProperty,y=Object.defineProperties;var k=Object.getOwnPropertyDescriptors;var v=Object.getOwnPropertySymbols;var $=Object.prototype.hasOwnProperty,I=Object.prototype.propertyIsEnumerable;var E=(e,t,n)=>t in e?w(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,g=(e,t)=>{for(var n in t||(t={}))$.call(t,n)&&E(e,n,t[n]);if(v)for(var n of v(t))I.call(t,n)&&E(e,n,t[n]);return e},A=(e,t)=>y(e,k(t));function diffLines(e,t){const n=e.length,o=t.length,s=[];for(let l=0;l<=n;l++)s.push(new Int32Array(o+1));for(let l=n-1;l>=0;l--)for(let c=o-1;c>=0;c--)s[l][c]=e[l]===t[c]?s[l+1][c+1]+1:Math.max(s[l+1][c],s[l][c+1]);const i=[];let r=0,a=0;for(;r<n&&a<o;)e[r]===t[a]?(i.push({type:"equal",aIndex:r,bIndex:a,text:e[r]}),r++,a++):s[r+1][a]>=s[r][a+1]?(i.push({type:"del",aIndex:r,text:e[r]}),r++):(i.push({type:"add",bIndex:a,text:t[a]}),a++);for(;r<n;)i.push({type:"del",aIndex:r,text:e[r]}),r++;for(;a<o;)i.push({type:"add",bIndex:a,text:t[a]}),a++;return i}function lcsMatchFlags(e,t){const n=e.length,o=t.length,s=[];for(let l=0;l<=n;l++)s.push(new Int32Array(o+1));for(let l=n-1;l>=0;l--)for(let c=o-1;c>=0;c--)s[l][c]=e[l]===t[c]?s[l+1][c+1]+1:Math.max(s[l+1][c],s[l][c+1]);const i=new Array(n).fill(!1);let r=0,a=0;for(;r<n&&a<o;)e[r]===t[a]?(i[r]=!0,r++,a++):s[r+1][a]>=s[r][a+1]?r++:a++;return i}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const t=[];for(const n of e){const o=t[t.length-1];o&&o.hi===n.hi?o.text+=n.text:t.push({text:n.text,hi:n.hi})}return t}function segDiff(e,t){const n=e.length,o=t.length,s=[];for(let c=0;c<=n;c++)s.push(new Int32Array(o+1));for(let c=n-1;c>=0;c--)for(let u=o-1;u>=0;u--)s[c][u]=e[c]===t[u]?s[c+1][u+1]+1:Math.max(s[c+1][u],s[c][u+1]);const i=[],r=[];let a=0,l=0;for(;a<n&&l<o;)e[a]===t[l]?(i.push({text:e[a],hi:!1}),r.push({text:t[l],hi:!1}),a++,l++):s[a+1][l]>=s[a][l+1]?(i.push({text:e[a],hi:!0}),a++):(r.push({text:t[l],hi:!0}),l++);for(;a<n;)i.push({text:e[a],hi:!0}),a++;for(;l<o;)r.push({text:t[l],hi:!0}),l++;return{oldSegs:mergeSegs(i),newSegs:mergeSegs(r)}}function wordDiff(e,t){return segDiff(tokenize(e),tokenize(t))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(l=>[{text:String(l),hi:!1}]);if(e.length===2){const l=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[l.oldSegs,l.newSegs]}const t=tokenizeName(e[0]),n=tokenizeName(e[1]),o=tokenizeName(e[2]),s=segDiff(t,n).newSegs,i=segDiff(t,o).newSegs,r=new Array(t.length).fill(!0);for(const l of[n,o]){const c=lcsMatchFlags(t,l);for(let u=0;u<t.length;u++)r[u]=r[u]&&c[u]}return[mergeSegs(t.map((l,c)=>({text:l,hi:!r[c]}))),s,i]}function build2Way(e,t){const n=diffLines(e,t),o=[];let s=0;for(;s<n.length;){if(n[s].type==="equal"){const l=n[s];o.push({type:"equal",left:{num:l.aIndex+1,segs:[{text:l.text,hi:!1}],kind:"plain"},right:{num:l.bIndex+1,segs:[{text:l.text,hi:!1}],kind:"plain"}}),s++;continue}const i=[];for(;s<n.length&&n[s].type==="del";)i.push(n[s++]);const r=[];for(;s<n.length&&n[s].type==="add";)r.push(n[s++]);const a=Math.max(i.length,r.length);for(let l=0;l<a;l++){const c=i[l],u=r[l];if(c&&u){const f=wordDiff(c.text,u.text);o.push({type:"mod",left:{num:c.aIndex+1,segs:f.oldSegs,kind:"del"},right:{num:u.bIndex+1,segs:f.newSegs,kind:"add"}})}else c?o.push({type:"del",left:{num:c.aIndex+1,segs:[{text:c.text,hi:!1}],kind:"del"},right:null}):o.push({type:"add",left:null,right:{num:u.bIndex+1,segs:[{text:u.text,hi:!1}],kind:"add"}})}}return o}function splitLines(e){const t=String(e).split(/\r\n|\r|\n/);return t.length>1&&t[t.length-1]===""&&t.pop(),t}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=g({},DEFAULTS.T),PANES,S=g({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(n=>n+n).join(""));const t=parseInt(e,16);return[t>>16&255,t>>8&255,t&255]}function toHex(e,t,n){const o=s=>("0"+Math.round(Math.max(0,Math.min(255,s))).toString(16)).slice(-2);return"#"+o(e)+o(t)+o(n)}function mixWhite(e,t){const[n,o,s]=hexToRgb(e),i=r=>255+(r-255)*t;return toHex(i(n),i(o),i(s))}function darken(e,t){const[n,o,s]=hexToRgb(e),i=r=>r*(1-t);return toHex(i(n),i(o),i(s))}function buildPane(e,t,n){return{bg:mixWhite(e,t),hi:mixWhite(e,n),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=g({},DEFAULTS.T),S=g({},DEFAULTS.S);const t=g({},DEFAULTS.paneColors);let n=DEFAULTS.lineOpacity,o=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const s=e.colors||{};HEX.test(s.baseColor||"")&&(t.base=s.baseColor),HEX.test(s.afterColor||"")&&(t.after=s.afterColor),HEX.test(s.refColor||"")&&(t.ref=s.refColor),isNum(e.diffLineOpacity)&&(n=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(o=e.diffCharOpacity);const i=e.syntax||{};i.keyword&&(S.keyword=i.keyword),i.literal&&(S.literal=i.literal),i.comment&&(S.comment=i.comment)}PANES={base:buildPane(t.base,n,o),after:buildPane(t.after,n,o),ref:buildPane(t.ref,n,o)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function sqlHighlight(e){const t=e.length;let n=0,o="";const s=(u,f,d)=>`<span style="color:${u};${d?"font-style:italic;":""}">${esc(f)}</span>`,i=u=>u===" "||u==="	",r=u=>u>="0"&&u<="9",a=u=>/[A-Za-z_]/.test(u),l=u=>/[A-Za-z0-9_]/.test(u),c=u=>"=<>!+-*/%|,.();:".indexOf(u)>=0;for(;n<t;){const u=e[n];if(i(u)){let f=n+1;for(;f<t&&i(e[f]);)f++;o+=esc(e.slice(n,f)),n=f;continue}if(u==="-"&&e[n+1]==="-"){o+=s(S.comment,e.slice(n),!0);break}if(u==="'"){let f=n+1;for(;f<t;){if(e[f]==="'"){if(e[f+1]==="'"){f+=2;continue}f++;break}f++}o+=s(S.literal,e.slice(n,f)),n=f;continue}if(r(u)){let f=n+1;for(;f<t&&(r(e[f])||e[f]===".");)f++;o+=s(S.literal,e.slice(n,f)),n=f;continue}if(a(u)){let f=n+1;for(;f<t&&l(e[f]);)f++;const d=e.slice(n,f);SQL_KEYWORDS.has(d.toUpperCase())?o+=s(S.keyword,d):o+=esc(d),n=f;continue}o+=esc(u),n++}return o}function renderSegs(e,t){if(!e||!e.length)return"&nbsp;";let n="";for(const o of e){const s=sqlHighlight(o.text);n+=o.hi?`<span style="background:${t};border-radius:2px;">${s}</span>`:s}return n===""?"&nbsp;":n}function numTd(e,t,n){const o=n?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${t.numBg};border-right:1px solid ${T.numBorder};${o}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,t){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${t.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${t.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,t,n){let o=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(o+=`background:${n.bg};border-left:2px solid ${n.bar};`),`<td style="${o}">${t||"&nbsp;"}</td>`}function hatchTd(e,t){const n=t?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${n}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${n}${T.hatch}">&nbsp;</td>`}function labelHtml(e,t){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(n=>n.hi?`<span style="background:${t.hi};border-radius:2px;">${esc(n.text)}</span>`:esc(n.text)).join("")}function th(e,t,n,o,s){const i=s?`border-left:1px solid ${T.border};`:"",r=n?`&nbsp;<span style="color:${o.headText};font-weight:400;">(${esc(n)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${o.headBg};border-bottom:2px solid ${o.bar};${i}padding:7px 12px;">${labelHtml(t,o)}${r}</th>`}function wrapTable(e,t,n){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:hidden;font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${t}</tr></thead>
    <tbody>
${n}    </tbody>
  </table>
</div>
`}function renderFragment1(e,t,n,o){configure(o);const s='<colgroup><col style="width:40px"><col></colgroup>',i=th(2,e,t,PANES.base,!1);let r="";for(let a=0;a<n.length;a++)r+=`      <tr>${numTd(a+1,PANES.base,!1)}${codeTd("same",sqlHighlight(n[a]),PANES.base)}</tr>
`;return wrapTable(s,i,r)}function renderFragment2(e,t,n,o){configure(o);const s='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',i=nameDiff([e,t]),r=th(3,i[0],"before",PANES.base,!1)+th(3,i[1],"after",PANES.after,!0);let a="";for(const l of n){const c=l.left,u=l.right;let f="";c?f+=numTd(c.num,PANES.base,!1)+markTd(c.kind==="del"?"del":"blank",PANES.base)+codeTd(c.kind,renderSegs(c.segs,PANES.base.hi),PANES.base):f+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),u?f+=numTd(u.num,PANES.after,!0)+markTd(u.kind==="add"?"add":"blank",PANES.after)+codeTd(u.kind,renderSegs(u.segs,PANES.after.hi),PANES.after):f+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),a+=`      <tr>${f}</tr>
`}return wrapTable(s,r,a)}const TOKEN_RE=new RegExp(["(`[^`]*`)","('(?:\\\\.|[^'\\\\])*')",'("(?:\\\\.|[^"\\\\])*")',"(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(\\d+(?:\\.\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],n=String(e==null?"":e);let o;for(TOKEN_RE.lastIndex=0;(o=TOKEN_RE.exec(n))!==null;){let s;o[1]?s="quoted":o[2]||o[3]?s="string":o[4]||o[5]?s="comment":o[6]?s="number":o[7]?s=KEYWORDS.has(o[7].toUpperCase())?"keyword":"ident":o[8]?s="space":s="punct",t.push({kind:s,text:o[0]})}return t}function stripOptionsClause(e){const t=[];let n=0;for(;n<e.length;){const o=e[n];if(o.kind==="keyword"&&o.text.toUpperCase()==="OPTIONS"){let s=n+1;for(;s<e.length&&e[s].kind==="space";)s++;if(s<e.length&&e[s].text==="("){let i=0,r=s;for(;r<e.length;r++)if(e[r].text==="(")i++;else if(e[r].text===")"&&(i--,i===0)){r++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();n=r;continue}}t.push(o),n++}return t}function normalizeSpace(e){return e.map(t=>t.kind==="space"?{kind:"space",text:" "}:t)}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/;function expandSuffixParts(e){let t=[""];for(const n of e){const o=[];for(const s of t)for(const i of n)o.push(s+i);t=o}return t.sort((n,o)=>o.length-n.length||n.localeCompare(o))}function extractSuffix(e,t){const n=t||{};if(Array.isArray(n.suffixParts)&&n.suffixParts.length>0){const i=n._expanded||(n._expanded=expandSuffixParts(n.suffixParts));for(const r of i)if(e.length>r.length+1&&e.endsWith("_"+r)){const a=[];let l=r;for(const c of n.suffixParts){const u=c.find(f=>l.startsWith(f));if(u===void 0){a.length=0;break}a.push(u),l=l.slice(u.length)}return{base:e.slice(0,-(r.length+1)),suffix:r,parts:a.length?a:void 0}}return null}if(Array.isArray(n.suffixList)&&n.suffixList.length>0){for(const i of n.suffixList)if(e.length>i.length+1&&e.endsWith("_"+i))return{base:e.slice(0,-(i.length+1)),suffix:i};return null}const o=n.suffixPattern?new RegExp(n.suffixPattern):DEFAULT_SUFFIX_RE,s=String(e).match(o);return s?{base:s[1],suffix:s[2]}:null}const DEFAULT_SUBSTITUTABLE=["ident","quoted"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001";function suffixWords(e,t){const n=String(e||"");if(n.length<2)return[];const o=[n];if(Array.isArray(t)&&t.length>0)for(const r of t)String(r).length>=2&&o.push(String(r));else n.length%2===0&&o.push(n.slice(0,n.length/2),n.slice(n.length/2));const s={},i=[];for(const r of o){const a=r.toLowerCase();s[a]||(s[a]=1,i.push(a))}return i}function buildLiteralMap(e){if(!Array.isArray(e)||e.length===0)return null;const t=typeof e[0]=="string"?[e]:e,n={};let o=0;for(let s=0;s<t.length;s++){if(!Array.isArray(t[s]))continue;const i=LITERAL_MARK+(s+1)+LITERAL_MARK;for(const r of t[s]){const a=String(r==null?"":r).toLowerCase();a&&(n[a]=i,o++)}}return o>0?n:null}function parseEquivalents(e){const t=e||{},n=t.equivalentLiterals;if(Array.isArray(n)){let o=!1;const s=[],i=[];for(const r of n)Array.isArray(r)?s.push(r):String(r).toLowerCase()==="suffix"?o=!0:r!=null&&i.push(r);return s.length===0&&i.length>0&&s.push(i),{useWords:o,groups:s.length>0?s:null}}return{useWords:t.literalSuffixWords!==!1,groups:Array.isArray(t.literalGroups)?t.literalGroups:null}}function maskTokens(e,t,n,o){const s=String(t||""),i=s.length>=2,r=parseEquivalents(o),a=i&&r.useWords?suffixWords(s,n):[],l=buildLiteralMap(r.groups);return!i&&a.length===0&&!l?e:e.map(c=>{if(c.kind==="space")return c;let u=c.text;if(i&&u.indexOf(s)>=0&&(u=u.split(s).join(SUFFIX_MARK)),a.length>0||l){const f=c.kind==="string"&&u.length>=2?u.slice(1,-1):c.kind==="number"?u:null;if(f){const d=f.toLowerCase(),p=a.indexOf(d)>=0?SUFFIX_MARK:l&&l[d];p&&(u=c.kind==="string"?u[0]+p+u[0]:p)}}return u===c.text?c:{kind:c.kind,text:u}})}function alphaMapDetail(e,t,n){if(e.length!==t.length)return{ok:!1,reason:"length",aLen:e.length,bLen:t.length};const o=new Set(n&&n.substitutable||DEFAULT_SUBSTITUTABLE),s=new Map,i=new Map;for(let r=0;r<e.length;r++){const a=e[r],l=t[r],c=u=>({ok:!1,reason:u,index:r,kind:a.kind,otherKind:l.kind,aText:a.text,bText:l.text});if(a.kind!==l.kind)return c("kind");if(a.text!==l.text){if(!o.has(a.kind))return c("not-substitutable");if(s.has(a.text)&&s.get(a.text)!==l.text)return c("inconsistent");if(i.has(l.text)&&i.get(l.text)!==a.text)return c("not-injective");s.set(a.text,l.text),i.set(l.text,a.text)}}return{ok:!0,fwd:s,rev:i}}function parameterize(e){const t=e[0].tokens.length,n=new Map,o=[],s=[];for(let i=0;i<t;i++){if(e[0].tokens[i].kind==="space"){s.push(e[0].raw[i].text);continue}const r=e.map(c=>c.raw[i].text);let a=!0;for(let c=1;c<r.length;c++)if(r[c]!==r[0]){a=!1;break}if(a){s.push(r[0]);continue}const l=JSON.stringify(r);if(!n.has(l)){const c="P"+(o.length+1);n.set(l,c);const u={};e.forEach((f,d)=>{u[f.suffix]=r[d]}),o.push({name:c,kind:e[0].raw[i].kind,values:u})}s.push("{{"+n.get(l)+"}}")}return{sql:s.join(""),params:o}}function groupByLogic(e,t){const n=!(t&&t.stripOptions===!1),o=!(t&&t.suffixAware===!1),s=e.map(r=>{let a=tokenizeSql(r.ddl);n&&(a=stripOptionsClause(a));const l=normalizeSpace(a);return A(g({},r),{raw:a,tokens:maskTokens(l,o?r.suffix:null,r.parts,t)})}),i=[];for(const r of s){let a=null,l=null;for(const c of i){const u=alphaMapDetail(c.members[0].tokens,r.tokens,t);if(u.ok){a=c;break}l||(l={vs:c.members[0].suffix,detail:u})}a?a.members.push(r):i.push({members:[r],miss:l})}return i.sort((r,a)=>a.members.length-r.members.length||String(r.members[0].suffix).localeCompare(String(a.members[0].suffix))),i.map(r=>{const a=r.members.slice().sort((c,u)=>String(c.suffix).localeCompare(String(u.suffix))),l=parameterize(a);return{suffixes:a.map(c=>c.suffix),members:a,sql:l.sql,params:l.params,miss:r.miss||null}})}function analyze(e,t){const n=!(t&&t.includeUnmatched===!1),o=new Map,s=[];for(const r of e){const a=extractSuffix(r.view_name,t);if(!a){s.push(r);continue}o.has(a.base)||o.set(a.base,[]),o.get(a.base).push({viewName:r.view_name,suffix:a.suffix,parts:a.parts,ddl:r.ddl})}const i=[];for(const[r,a]of o){const l=groupByLogic(a,t);i.push({base:r,viewCount:a.length,groupCount:l.length,groups:l})}if(n)for(const r of s){const a=[{viewName:r.view_name,suffix:null,parts:null,ddl:r.ddl}];i.push({base:r.view_name,viewCount:1,groupCount:1,groups:groupByLogic(a,t),unmatched:!0})}return i.sort((r,a)=>a.groupCount-r.groupCount||r.base.localeCompare(a.base)),{bases:i,unmatched:s}}const MAX_TABS=12;function esc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(e){let t=2166136261;for(let n=0;n<String(e).length;n++)t^=String(e).charCodeAt(n),t=Math.imul(t,16777619)>>>0;return t.toString(36)}const label=e=>e.suffixes.map((t,n)=>t||e.members[n]&&e.members[n].viewName||"(suffix \u306A\u3057)").join(", ");function relabelPanes(e,t){let n=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(o,s,i)=>{const r=t[n++];return r==null?o:s+esc(r)+i})}const paneSub=e=>`${e.members.length} View`;function badge(e,t,n){return`<span class="vg-badge" style="color:${t};background:${n}">${esc(e)}</span>`}function header(e,t,n,o){const s=n>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${t} View`,"#57606A","#EAEEF2")+badge(`${n} \u30B0\u30EB\u30FC\u30D7`,s?"#9A6700":"#1A7F37",s?"#FFF8C5":"#DAFBE1")+(o?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u5BFE\u8C61\u5916\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u65E2\u5B9A\u3067\u306F\u30EA\u30C6\u30E9\u30EB\u3082\u3053\u3053\u306B\u5165\u308B\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e){const t=i=>String(i==null?"":i).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),n=e.filter(i=>i.miss).map(i=>{const r=i.miss.detail,a=r.reason==="length"?`${r.aLen} \u5BFE ${r.bLen}`:`<code class="vg-mcode">${esc(t(r.aText))}</code> \u2194 <code class="vg-mcode">${esc(t(r.bText))}</code><span class="vg-mkind">${esc(r.kind)}</span>`;return`<tr><th class="vg-mname">${esc(label(i))}</th><td class="vg-mvs">vs ${esc(i.miss.vs)}</td><td class="vg-mreason">${esc(REASON_TEXT[r.reason]||r.reason)}<br>${a}</td></tr>`}).join("");return n?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(i=>i.miss&&i.miss.detail.reason==="not-substitutable"&&(i.miss.detail.kind==="string"||i.miss.detail.kind==="number"))?`<div class="vg-mhint">\u30EA\u30C6\u30E9\u30EB\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002suffix \u3068\u9023\u52D5\u3059\u308B\u5024\uFF08<code class="vg-mcode">'JP'</code> / <code class="vg-mcode">'US'</code> \u306A\u3069\uFF09\u306F\u65E2\u5B9A\u3067\u5438\u53CE\u3059\u308B\u306E\u3067\u3001\u3053\u3053\u306B\u6B8B\u3063\u3066\u3044\u308B\u306E\u306F\u9023\u52D5\u3057\u3066\u3044\u306A\u3044\u5024\u3067\u3059\u3002\u305D\u308C\u3067\u3082\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001options_json \u306B <code class="vg-mcode">"substitutable": ["ident","quoted","number","string"]</code> \u3092\u6307\u5B9A\u3059\u308B\u3068<b>\u3059\u3079\u3066\u306E</b>\u30EA\u30C6\u30E9\u30EB\u5DEE\u304C\u7121\u8996\u3055\u308C\u307E\u3059\uFF08<code class="vg-mcode">'A'</code> \u3068 <code class="vg-mcode">'B'</code> \u306E\u5DEE\u3082\u6D88\u3048\u307E\u3059\uFF09\u3002<br>\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>`:""}<div class="vg-pblock"><table class="vg-ptable">${n}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(n=>{if(!n.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(n))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const o=n.params.map(s=>{const i=Object.entries(s.values).map(([r,a])=>`<div class="vg-pv"><span class="vg-psuf">${esc(r)}</span>${esc(a)}</div>`).join("");return`<tr><th class="vg-pname">${esc(s.name)}</th><td class="vg-pvals">${i}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(n))}</div><table class="vg-ptable">${o}</table></div>`}).join("")}</details>`}function pair(e,t,n){return relabelPanes(renderFragment2(label(e),label(t),build2Way(splitLines(e.sql),splitLines(t.sql)),n),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(t)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,t,n){const[o,...s]=e,i=s.slice(0,MAX_TABS),r=i.map((u,f)=>`<input class="vg-r vg-r${f+1}" type="radio" name="${n}" id="${n}-${f+1}"${f===0?" checked":""}>`).join(""),a=baseTab(o)+i.map((u,f)=>`<label class="vg-tab vg-t${f+1}" for="${n}-${f+1}">${esc(label(u))}<span class="vg-tabn">${u.members.length}</span></label>`).join(""),l=i.length?i.map((u,f)=>`<div class="vg-panel vg-p${f+1}">${pair(o,u,t)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(o),paneSub(o),splitLines(o.sql),t)}</div>`;return(s.length>i.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D ${MAX_TABS} \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${s.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${r}<div class="vg-tablist">${a}</div><div class="vg-panels">${l}</div></div>`}function renderBase(e,t){const n=t||{},o=e.groups,s=o.length,i="vgt"+hashId(e.base+"|"+o.map(label).join("|"));let r;return s===0?r=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):r=(s>1?"":notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`))+tabs(o,n,i),'<div class="vg-root">'+header(e.base,e.viewCount,s,e.unmatched)+r+missTable(o)+paramsTable(o)+"</div>"}function chromeCss(){const e=[".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font:600 15px/1.6 inherit;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font:600 12px/1.8 inherit;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font:600 12px/1.6 inherit;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}"];for(let t=1;t<=MAX_TABS;t++)e.push(`.vg-r${t}:checked ~ .vg-panels > .vg-p${t}{display:block}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t}{background:#fff;border-color:#D0D7DE;color:#24292F}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t} .vg-tabn{background:#DDF4FF;color:#0969DA}`);return e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var t=2166136261,n=0;n<e.length;n++)t^=e.charCodeAt(n),t=Math.imul(t,16777619)>>>0;return"d"+t.toString(36)}function __split(e){var t={},n=e.replace(/ style="([^"]*)"/g,function(o,s){var i=__hashClass(s);return t[i]=s,' class="'+i+'"'});return{markup:n,rules:t}}function __rulesToCss(e){for(var t=Object.keys(e).sort(),n=[],o=0;o<t.length;o++)n.push("."+t[o]+"{"+e[t[o]]+"}");return n.join(`
`)}function __applyMode(e,t){if(t==="class")return __split(e).markup;if(t==="embed"){var n=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(n.rules)+`
</style>
`+n.markup}return e}function __empty(e){return{view_count:0,group_count:0,group_labels:[],group_sizes:[],suffixes:[],unmatched_count:0,html:__notice(e)}}function __run(e,t){var n=__opts(t);if(!e||e.length===0)return __empty("View \u304C\u6E21\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002");for(var o=[],s=0;s<e.length;s++)e[s]&&o.push({view_name:e[s].view_name,ddl:e[s].ddl});var i=analyze(o,n);if(i.bases.length===0){var r=__empty(o.length+" \u4EF6\u3059\u3079\u3066 suffix \u3092\u8A8D\u8B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002suffixParts / suffixList / suffixPattern \u306E\u6307\u5B9A\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");return r.unmatched_count=i.unmatched.length,r}for(var a="",l=[],c=[],u=[],f=0,d=0,p=0;p<i.bases.length;p++){var h=i.bases[p];a+=renderBase(h,n),f+=h.viewCount,d+=h.groupCount;for(var b=0;b<h.groups.length;b++){var x=h.groups[b];l.push(label(x)),c.push(x.members.length);for(var m=0;m<x.suffixes.length;m++)u.push(x.suffixes[m]||x.members[m].viewName)}}return i.unmatched.length>0&&n.includeUnmatched===!1&&(a+=__notice("suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u304C "+i.unmatched.length+" \u4EF6\u3042\u308A\u307E\u3059\u3002")),{view_count:f,group_count:d,group_labels:l,group_sizes:c,suffixes:u.sort(),unmatched_count:i.unmatched.length,html:__applyMode(a,n.mode||"inline")}}return __run(views,options_json);

""";

DECLARE js_css STRING DEFAULT r"""
var A=Object.defineProperty,w=Object.defineProperties;var y=Object.getOwnPropertyDescriptors;var m=Object.getOwnPropertySymbols;var k=Object.prototype.hasOwnProperty,$=Object.prototype.propertyIsEnumerable;var E=(e,t,n)=>t in e?A(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,g=(e,t)=>{for(var n in t||(t={}))k.call(t,n)&&E(e,n,t[n]);if(m)for(var n of m(t))$.call(t,n)&&E(e,n,t[n]);return e},v=(e,t)=>w(e,y(t));function diffLines(e,t){const n=e.length,s=t.length,r=[];for(let l=0;l<=n;l++)r.push(new Int32Array(s+1));for(let l=n-1;l>=0;l--)for(let c=s-1;c>=0;c--)r[l][c]=e[l]===t[c]?r[l+1][c+1]+1:Math.max(r[l+1][c],r[l][c+1]);const i=[];let o=0,a=0;for(;o<n&&a<s;)e[o]===t[a]?(i.push({type:"equal",aIndex:o,bIndex:a,text:e[o]}),o++,a++):r[o+1][a]>=r[o][a+1]?(i.push({type:"del",aIndex:o,text:e[o]}),o++):(i.push({type:"add",bIndex:a,text:t[a]}),a++);for(;o<n;)i.push({type:"del",aIndex:o,text:e[o]}),o++;for(;a<s;)i.push({type:"add",bIndex:a,text:t[a]}),a++;return i}function lcsMatchFlags(e,t){const n=e.length,s=t.length,r=[];for(let l=0;l<=n;l++)r.push(new Int32Array(s+1));for(let l=n-1;l>=0;l--)for(let c=s-1;c>=0;c--)r[l][c]=e[l]===t[c]?r[l+1][c+1]+1:Math.max(r[l+1][c],r[l][c+1]);const i=new Array(n).fill(!1);let o=0,a=0;for(;o<n&&a<s;)e[o]===t[a]?(i[o]=!0,o++,a++):r[o+1][a]>=r[o][a+1]?o++:a++;return i}function tokenize(e){return e.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g)||[]}function mergeSegs(e){const t=[];for(const n of e){const s=t[t.length-1];s&&s.hi===n.hi?s.text+=n.text:t.push({text:n.text,hi:n.hi})}return t}function segDiff(e,t){const n=e.length,s=t.length,r=[];for(let c=0;c<=n;c++)r.push(new Int32Array(s+1));for(let c=n-1;c>=0;c--)for(let f=s-1;f>=0;f--)r[c][f]=e[c]===t[f]?r[c+1][f+1]+1:Math.max(r[c+1][f],r[c][f+1]);const i=[],o=[];let a=0,l=0;for(;a<n&&l<s;)e[a]===t[l]?(i.push({text:e[a],hi:!1}),o.push({text:t[l],hi:!1}),a++,l++):r[a+1][l]>=r[a][l+1]?(i.push({text:e[a],hi:!0}),a++):(o.push({text:t[l],hi:!0}),l++);for(;a<n;)i.push({text:e[a],hi:!0}),a++;for(;l<s;)o.push({text:t[l],hi:!0}),l++;return{oldSegs:mergeSegs(i),newSegs:mergeSegs(o)}}function wordDiff(e,t){return segDiff(tokenize(e),tokenize(t))}function tokenizeName(e){return String(e).match(/([^._\-\s]+|[._\-\s])/g)||[]}function nameDiff(e){if(!Array.isArray(e)||e.length<2)return(e||[]).map(l=>[{text:String(l),hi:!1}]);if(e.length===2){const l=segDiff(tokenizeName(e[0]),tokenizeName(e[1]));return[l.oldSegs,l.newSegs]}const t=tokenizeName(e[0]),n=tokenizeName(e[1]),s=tokenizeName(e[2]),r=segDiff(t,n).newSegs,i=segDiff(t,s).newSegs,o=new Array(t.length).fill(!0);for(const l of[n,s]){const c=lcsMatchFlags(t,l);for(let f=0;f<t.length;f++)o[f]=o[f]&&c[f]}return[mergeSegs(t.map((l,c)=>({text:l,hi:!o[c]}))),r,i]}function build2Way(e,t){const n=diffLines(e,t),s=[];let r=0;for(;r<n.length;){if(n[r].type==="equal"){const l=n[r];s.push({type:"equal",left:{num:l.aIndex+1,segs:[{text:l.text,hi:!1}],kind:"plain"},right:{num:l.bIndex+1,segs:[{text:l.text,hi:!1}],kind:"plain"}}),r++;continue}const i=[];for(;r<n.length&&n[r].type==="del";)i.push(n[r++]);const o=[];for(;r<n.length&&n[r].type==="add";)o.push(n[r++]);const a=Math.max(i.length,o.length);for(let l=0;l<a;l++){const c=i[l],f=o[l];if(c&&f){const u=wordDiff(c.text,f.text);s.push({type:"mod",left:{num:c.aIndex+1,segs:u.oldSegs,kind:"del"},right:{num:f.bIndex+1,segs:u.newSegs,kind:"add"}})}else c?s.push({type:"del",left:{num:c.aIndex+1,segs:[{text:c.text,hi:!1}],kind:"del"},right:null}):s.push({type:"add",left:null,right:{num:f.bIndex+1,segs:[{text:f.text,hi:!1}],kind:"add"}})}}return s}function splitLines(e){const t=String(e).split(/\r\n|\r|\n/);return t.length>1&&t[t.length-1]===""&&t.pop(),t}const DEFAULT_FONT="'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace",DEFAULTS={T:{font:DEFAULT_FONT,headFont:"'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",fontSize:12,lineHeight:1.35,text:"#24292F",title:"#1A1A1A",num:"#B0BAC5",numBorder:"#ECEFF1",border:"#E0E0E0",headSub:"#90A4AE",emptyBg:"#FAFAFA",shadow:"0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)",hatch:"background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);"},paneColors:{base:"#E17B7B",after:"#93AE68",ref:"#7E9BC8"},lineOpacity:.3,charOpacity:.55,S:{keyword:"#CF222E",literal:"#098658",comment:"#6E7781"},fontFamily:DEFAULT_FONT};let T=g({},DEFAULTS.T),PANES,S=g({},DEFAULTS.S);function isNum(e){return typeof e=="number"&&isFinite(e)}const HEX=/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;function hexToRgb(e){e=e.replace("#",""),e.length===3&&(e=e.split("").map(n=>n+n).join(""));const t=parseInt(e,16);return[t>>16&255,t>>8&255,t&255]}function toHex(e,t,n){const s=r=>("0"+Math.round(Math.max(0,Math.min(255,r))).toString(16)).slice(-2);return"#"+s(e)+s(t)+s(n)}function mixWhite(e,t){const[n,s,r]=hexToRgb(e),i=o=>255+(o-255)*t;return toHex(i(n),i(s),i(r))}function darken(e,t){const[n,s,r]=hexToRgb(e),i=o=>o*(1-t);return toHex(i(n),i(s),i(r))}function buildPane(e,t,n){return{bg:mixWhite(e,t),hi:mixWhite(e,n),bar:e,mark:darken(e,.28),numBg:mixWhite(e,.05),headText:darken(e,.4),headBg:mixWhite(e,.14)}}function configure(e){T=g({},DEFAULTS.T),S=g({},DEFAULTS.S);const t=g({},DEFAULTS.paneColors);let n=DEFAULTS.lineOpacity,s=DEFAULTS.charOpacity;if(e){e.fontFamily&&(T.font=e.fontFamily),isNum(e.fontSize)&&(T.fontSize=e.fontSize),isNum(e.lineHeight)&&(T.lineHeight=e.lineHeight);const r=e.colors||{};HEX.test(r.baseColor||"")&&(t.base=r.baseColor),HEX.test(r.afterColor||"")&&(t.after=r.afterColor),HEX.test(r.refColor||"")&&(t.ref=r.refColor),isNum(e.diffLineOpacity)&&(n=e.diffLineOpacity),isNum(e.diffCharOpacity)&&(s=e.diffCharOpacity);const i=e.syntax||{};i.keyword&&(S.keyword=i.keyword),i.literal&&(S.literal=i.literal),i.comment&&(S.comment=i.comment)}PANES={base:buildPane(t.base,n,s),after:buildPane(t.after,n,s),ref:buildPane(t.ref,n,s)}}configure();const SQL_KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST".split(/\s+/));function sqlHighlight(e){const t=e.length;let n=0,s="";const r=(f,u,d)=>`<span style="color:${f};${d?"font-style:italic;":""}">${esc(u)}</span>`,i=f=>f===" "||f==="	",o=f=>f>="0"&&f<="9",a=f=>/[A-Za-z_]/.test(f),l=f=>/[A-Za-z0-9_]/.test(f),c=f=>"=<>!+-*/%|,.();:".indexOf(f)>=0;for(;n<t;){const f=e[n];if(i(f)){let u=n+1;for(;u<t&&i(e[u]);)u++;s+=esc(e.slice(n,u)),n=u;continue}if(f==="-"&&e[n+1]==="-"){s+=r(S.comment,e.slice(n),!0);break}if(f==="'"){let u=n+1;for(;u<t;){if(e[u]==="'"){if(e[u+1]==="'"){u+=2;continue}u++;break}u++}s+=r(S.literal,e.slice(n,u)),n=u;continue}if(o(f)){let u=n+1;for(;u<t&&(o(e[u])||e[u]===".");)u++;s+=r(S.literal,e.slice(n,u)),n=u;continue}if(a(f)){let u=n+1;for(;u<t&&l(e[u]);)u++;const d=e.slice(n,u);SQL_KEYWORDS.has(d.toUpperCase())?s+=r(S.keyword,d):s+=esc(d),n=u;continue}s+=esc(f),n++}return s}function renderSegs(e,t){if(!e||!e.length)return"&nbsp;";let n="";for(const s of e){const r=sqlHighlight(s.text);n+=s.hi?`<span style="background:${t};border-radius:2px;">${r}</span>`:r}return n===""?"&nbsp;":n}function numTd(e,t,n){const s=n?`border-left:1px solid ${T.border};`:"";return`<td style="padding:0 10px;text-align:right;color:${T.num};background:${t.numBg};border-right:1px solid ${T.numBorder};${s}white-space:nowrap;">${e==null?"&nbsp;":e}</td>`}function markTd(e,t){return e==="add"?`<td style="padding:0 4px;text-align:center;color:${t.mark};">+</td>`:e==="del"?`<td style="padding:0 4px;text-align:center;color:${t.mark};">\u2212</td>`:`<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`}function codeTd(e,t,n){let s=`padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;return(e==="add"||e==="del"||e==="diff")&&(s+=`background:${n.bg};border-left:2px solid ${n.bar};`),`<td style="${s}">${t||"&nbsp;"}</td>`}function hatchTd(e,t){const n=t?`border-left:1px solid ${T.border};`:"";return e==="num"?`<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${n}${T.hatch}">&nbsp;</td>`:e==="mark"?`<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`:`<td style="padding:0 12px;white-space:pre-wrap;${n}${T.hatch}">&nbsp;</td>`}function labelHtml(e,t){return typeof e=="string"&&(e=[{text:e,hi:!1}]),e.map(n=>n.hi?`<span style="background:${t.hi};border-radius:2px;">${esc(n.text)}</span>`:esc(n.text)).join("")}function th(e,t,n,s,r){const i=r?`border-left:1px solid ${T.border};`:"",o=n?`&nbsp;<span style="color:${s.headText};font-weight:400;">(${esc(n)})</span>`:"";return`<th colspan="${e}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${s.headBg};border-bottom:2px solid ${s.bar};${i}padding:7px 12px;">${labelHtml(t,s)}${o}</th>`}function wrapTable(e,t,n){return`<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">
  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:hidden;font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    ${e}
    <thead><tr>${t}</tr></thead>
    <tbody>
${n}    </tbody>
  </table>
</div>
`}function renderFragment1(e,t,n,s){configure(s);const r='<colgroup><col style="width:40px"><col></colgroup>',i=th(2,e,t,PANES.base,!1);let o="";for(let a=0;a<n.length;a++)o+=`      <tr>${numTd(a+1,PANES.base,!1)}${codeTd("same",sqlHighlight(n[a]),PANES.base)}</tr>
`;return wrapTable(r,i,o)}function renderFragment2(e,t,n,s){configure(s);const r='<colgroup><col style="width:40px"><col style="width:22px"><col><col style="width:40px"><col style="width:22px"><col></colgroup>',i=nameDiff([e,t]),o=th(3,i[0],"before",PANES.base,!1)+th(3,i[1],"after",PANES.after,!0);let a="";for(const l of n){const c=l.left,f=l.right;let u="";c?u+=numTd(c.num,PANES.base,!1)+markTd(c.kind==="del"?"del":"blank",PANES.base)+codeTd(c.kind,renderSegs(c.segs,PANES.base.hi),PANES.base):u+=hatchTd("num",!1)+hatchTd("mark",!1)+hatchTd("code",!1),f?u+=numTd(f.num,PANES.after,!0)+markTd(f.kind==="add"?"add":"blank",PANES.after)+codeTd(f.kind,renderSegs(f.segs,PANES.after.hi),PANES.after):u+=hatchTd("num",!0)+hatchTd("mark",!0)+hatchTd("code",!0),a+=`      <tr>${u}</tr>
`}return wrapTable(r,o,a)}const TOKEN_RE=new RegExp(["(`[^`]*`)","('(?:\\\\.|[^'\\\\])*')",'("(?:\\\\.|[^"\\\\])*")',"(--[^\\n]*|#[^\\n]*)","(/\\*[\\s\\S]*?\\*/)","(\\d+(?:\\.\\d+)?)","([A-Za-z_][A-Za-z0-9_]*)","(\\s+)","([^\\s])"].join("|"),"g"),KEYWORDS=new Set("SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET QUALIFY WINDOW UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END CREATE OR REPLACE VIEW TABLE FUNCTION IF EXISTS OPTIONS WITH RECURSIVE OVER PARTITION UNNEST STRUCT ARRAY CAST SAFE_CAST EXTRACT INTERVAL DATE DATETIME TIME TIMESTAMP INT64 FLOAT64 NUMERIC BIGNUMERIC STRING BYTES BOOL TRUE FALSE COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF ROWS RANGE PRECEDING FOLLOWING CURRENT ROW".split(/\s+/));function tokenizeSql(e){const t=[],n=String(e==null?"":e);let s;for(TOKEN_RE.lastIndex=0;(s=TOKEN_RE.exec(n))!==null;){let r;s[1]?r="quoted":s[2]||s[3]?r="string":s[4]||s[5]?r="comment":s[6]?r="number":s[7]?r=KEYWORDS.has(s[7].toUpperCase())?"keyword":"ident":s[8]?r="space":r="punct",t.push({kind:r,text:s[0]})}return t}function stripOptionsClause(e){const t=[];let n=0;for(;n<e.length;){const s=e[n];if(s.kind==="keyword"&&s.text.toUpperCase()==="OPTIONS"){let r=n+1;for(;r<e.length&&e[r].kind==="space";)r++;if(r<e.length&&e[r].text==="("){let i=0,o=r;for(;o<e.length;o++)if(e[o].text==="(")i++;else if(e[o].text===")"&&(i--,i===0)){o++;break}for(;t.length>0&&t[t.length-1].kind==="space";)t.pop();n=o;continue}}t.push(s),n++}return t}function normalizeSpace(e){return e.map(t=>t.kind==="space"?{kind:"space",text:" "}:t)}const DEFAULT_SUFFIX_RE=/^(.*?)_([A-Za-z0-9]{1,6})$/;function expandSuffixParts(e){let t=[""];for(const n of e){const s=[];for(const r of t)for(const i of n)s.push(r+i);t=s}return t.sort((n,s)=>s.length-n.length||n.localeCompare(s))}function extractSuffix(e,t){const n=t||{};if(Array.isArray(n.suffixParts)&&n.suffixParts.length>0){const i=n._expanded||(n._expanded=expandSuffixParts(n.suffixParts));for(const o of i)if(e.length>o.length+1&&e.endsWith("_"+o)){const a=[];let l=o;for(const c of n.suffixParts){const f=c.find(u=>l.startsWith(u));if(f===void 0){a.length=0;break}a.push(f),l=l.slice(f.length)}return{base:e.slice(0,-(o.length+1)),suffix:o,parts:a.length?a:void 0}}return null}if(Array.isArray(n.suffixList)&&n.suffixList.length>0){for(const i of n.suffixList)if(e.length>i.length+1&&e.endsWith("_"+i))return{base:e.slice(0,-(i.length+1)),suffix:i};return null}const s=n.suffixPattern?new RegExp(n.suffixPattern):DEFAULT_SUFFIX_RE,r=String(e).match(s);return r?{base:r[1],suffix:r[2]}:null}const DEFAULT_SUBSTITUTABLE=["ident","quoted"],SUFFIX_MARK="\0",LITERAL_MARK="\u0001";function suffixWords(e,t){const n=String(e||"");if(n.length<2)return[];const s=[n];if(Array.isArray(t)&&t.length>0)for(const o of t)String(o).length>=2&&s.push(String(o));else n.length%2===0&&s.push(n.slice(0,n.length/2),n.slice(n.length/2));const r={},i=[];for(const o of s){const a=o.toLowerCase();r[a]||(r[a]=1,i.push(a))}return i}function buildLiteralMap(e){if(!Array.isArray(e)||e.length===0)return null;const t=typeof e[0]=="string"?[e]:e,n={};let s=0;for(let r=0;r<t.length;r++){if(!Array.isArray(t[r]))continue;const i=LITERAL_MARK+(r+1)+LITERAL_MARK;for(const o of t[r]){const a=String(o==null?"":o).toLowerCase();a&&(n[a]=i,s++)}}return s>0?n:null}function parseEquivalents(e){const t=e||{},n=t.equivalentLiterals;if(Array.isArray(n)){let s=!1;const r=[],i=[];for(const o of n)Array.isArray(o)?r.push(o):String(o).toLowerCase()==="suffix"?s=!0:o!=null&&i.push(o);return r.length===0&&i.length>0&&r.push(i),{useWords:s,groups:r.length>0?r:null}}return{useWords:t.literalSuffixWords!==!1,groups:Array.isArray(t.literalGroups)?t.literalGroups:null}}function maskTokens(e,t,n,s){const r=String(t||""),i=r.length>=2,o=parseEquivalents(s),a=i&&o.useWords?suffixWords(r,n):[],l=buildLiteralMap(o.groups);return!i&&a.length===0&&!l?e:e.map(c=>{if(c.kind==="space")return c;let f=c.text;if(i&&f.indexOf(r)>=0&&(f=f.split(r).join(SUFFIX_MARK)),a.length>0||l){const u=c.kind==="string"&&f.length>=2?f.slice(1,-1):c.kind==="number"?f:null;if(u){const d=u.toLowerCase(),p=a.indexOf(d)>=0?SUFFIX_MARK:l&&l[d];p&&(f=c.kind==="string"?f[0]+p+f[0]:p)}}return f===c.text?c:{kind:c.kind,text:f}})}function alphaMapDetail(e,t,n){if(e.length!==t.length)return{ok:!1,reason:"length",aLen:e.length,bLen:t.length};const s=new Set(n&&n.substitutable||DEFAULT_SUBSTITUTABLE),r=new Map,i=new Map;for(let o=0;o<e.length;o++){const a=e[o],l=t[o],c=f=>({ok:!1,reason:f,index:o,kind:a.kind,otherKind:l.kind,aText:a.text,bText:l.text});if(a.kind!==l.kind)return c("kind");if(a.text!==l.text){if(!s.has(a.kind))return c("not-substitutable");if(r.has(a.text)&&r.get(a.text)!==l.text)return c("inconsistent");if(i.has(l.text)&&i.get(l.text)!==a.text)return c("not-injective");r.set(a.text,l.text),i.set(l.text,a.text)}}return{ok:!0,fwd:r,rev:i}}function parameterize(e){const t=e[0].tokens.length,n=new Map,s=[],r=[];for(let i=0;i<t;i++){if(e[0].tokens[i].kind==="space"){r.push(e[0].raw[i].text);continue}const o=e.map(c=>c.raw[i].text);let a=!0;for(let c=1;c<o.length;c++)if(o[c]!==o[0]){a=!1;break}if(a){r.push(o[0]);continue}const l=JSON.stringify(o);if(!n.has(l)){const c="P"+(s.length+1);n.set(l,c);const f={};e.forEach((u,d)=>{f[u.suffix]=o[d]}),s.push({name:c,kind:e[0].raw[i].kind,values:f})}r.push("{{"+n.get(l)+"}}")}return{sql:r.join(""),params:s}}function groupByLogic(e,t){const n=!(t&&t.stripOptions===!1),s=!(t&&t.suffixAware===!1),r=e.map(o=>{let a=tokenizeSql(o.ddl);n&&(a=stripOptionsClause(a));const l=normalizeSpace(a);return v(g({},o),{raw:a,tokens:maskTokens(l,s?o.suffix:null,o.parts,t)})}),i=[];for(const o of r){let a=null,l=null;for(const c of i){const f=alphaMapDetail(c.members[0].tokens,o.tokens,t);if(f.ok){a=c;break}l||(l={vs:c.members[0].suffix,detail:f})}a?a.members.push(o):i.push({members:[o],miss:l})}return i.sort((o,a)=>a.members.length-o.members.length||String(o.members[0].suffix).localeCompare(String(a.members[0].suffix))),i.map(o=>{const a=o.members.slice().sort((c,f)=>String(c.suffix).localeCompare(String(f.suffix))),l=parameterize(a);return{suffixes:a.map(c=>c.suffix),members:a,sql:l.sql,params:l.params,miss:o.miss||null}})}function analyze(e,t){const n=!(t&&t.includeUnmatched===!1),s=new Map,r=[];for(const o of e){const a=extractSuffix(o.view_name,t);if(!a){r.push(o);continue}s.has(a.base)||s.set(a.base,[]),s.get(a.base).push({viewName:o.view_name,suffix:a.suffix,parts:a.parts,ddl:o.ddl})}const i=[];for(const[o,a]of s){const l=groupByLogic(a,t);i.push({base:o,viewCount:a.length,groupCount:l.length,groups:l})}if(n)for(const o of r){const a=[{viewName:o.view_name,suffix:null,parts:null,ddl:o.ddl}];i.push({base:o.view_name,viewCount:1,groupCount:1,groups:groupByLogic(a,t),unmatched:!0})}return i.sort((o,a)=>a.groupCount-o.groupCount||o.base.localeCompare(a.base)),{bases:i,unmatched:r}}const MAX_TABS=12;function esc(e){return String(e==null?"":e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function hashId(e){let t=2166136261;for(let n=0;n<String(e).length;n++)t^=String(e).charCodeAt(n),t=Math.imul(t,16777619)>>>0;return t.toString(36)}const label=e=>e.suffixes.map((t,n)=>t||e.members[n]&&e.members[n].viewName||"(suffix \u306A\u3057)").join(", ");function relabelPanes(e,t){let n=0;return e.replace(/(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,(s,r,i)=>{const o=t[n++];return o==null?s:r+esc(o)+i})}const paneSub=e=>`${e.members.length} View`;function badge(e,t,n){return`<span class="vg-badge" style="color:${t};background:${n}">${esc(e)}</span>`}function header(e,t,n,s){const r=n>1;return`<div class="vg-header"><span class="vg-title">${esc(e)}</span>`+badge(`${t} View`,"#57606A","#EAEEF2")+badge(`${n} \u30B0\u30EB\u30FC\u30D7`,r?"#9A6700":"#1A7F37",r?"#FFF8C5":"#DAFBE1")+(s?badge("suffix \u672A\u8A8D\u8B58","#9A6700","#FFF8C5"):"")+"</div>"}function notice(e){return`<div class="vg-notice">${esc(e)}</div>`}const REASON_TEXT={length:"\u30C8\u30FC\u30AF\u30F3\u6570\u304C\u9055\u3046\uFF08\u69CB\u9020\u305D\u306E\u3082\u306E\u304C\u5225\uFF09",kind:"\u30C8\u30FC\u30AF\u30F3\u306E\u7A2E\u985E\u304C\u9055\u3046","not-substitutable":"\u7F6E\u63DB\u5BFE\u8C61\u5916\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u9055\u3046\uFF08\u65E2\u5B9A\u3067\u306F\u30EA\u30C6\u30E9\u30EB\u3082\u3053\u3053\u306B\u5165\u308B\uFF09",inconsistent:"\u540C\u3058\u30C8\u30FC\u30AF\u30F3\u304C\u5225\u306E\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066\u4E00\u8CAB\u3057\u306A\u3044","not-injective":"\u5225\u3005\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u540C\u3058\u5024\u306B\u5BFE\u5FDC\u3057\u3066\u3044\u3066 1 \u5BFE 1 \u306B\u306A\u3089\u306A\u3044"};function missTable(e){const t=i=>String(i==null?"":i).split("\0").join("\u27E8suffix\u27E9").replace(/\u0001(\d+)\u0001/g,"\u27E8\u540C\u5024\u30EA\u30C6\u30E9\u30EB $1 \u7D44\u76EE\u27E9"),n=e.filter(i=>i.miss).map(i=>{const o=i.miss.detail,a=o.reason==="length"?`${o.aLen} \u5BFE ${o.bLen}`:`<code class="vg-mcode">${esc(t(o.aText))}</code> \u2194 <code class="vg-mcode">${esc(t(o.bText))}</code><span class="vg-mkind">${esc(o.kind)}</span>`;return`<tr><th class="vg-mname">${esc(label(i))}</th><td class="vg-mvs">vs ${esc(i.miss.vs)}</td><td class="vg-mreason">${esc(REASON_TEXT[o.reason]||o.reason)}<br>${a}</td></tr>`}).join("");return n?`<details class="vg-params vg-miss"><summary class="vg-psummary">\u306A\u305C\u5225\u30B0\u30EB\u30FC\u30D7\u306B\u306A\u3063\u305F\u304B</summary>${e.some(i=>i.miss&&i.miss.detail.reason==="not-substitutable"&&(i.miss.detail.kind==="string"||i.miss.detail.kind==="number"))?`<div class="vg-mhint">\u30EA\u30C6\u30E9\u30EB\u306E\u9055\u3044\u3067\u5272\u308C\u3066\u3044\u307E\u3059\u3002suffix \u3068\u9023\u52D5\u3059\u308B\u5024\uFF08<code class="vg-mcode">'JP'</code> / <code class="vg-mcode">'US'</code> \u306A\u3069\uFF09\u306F\u65E2\u5B9A\u3067\u5438\u53CE\u3059\u308B\u306E\u3067\u3001\u3053\u3053\u306B\u6B8B\u3063\u3066\u3044\u308B\u306E\u306F\u9023\u52D5\u3057\u3066\u3044\u306A\u3044\u5024\u3067\u3059\u3002\u305D\u308C\u3067\u3082\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001options_json \u306B <code class="vg-mcode">"substitutable": ["ident","quoted","number","string"]</code> \u3092\u6307\u5B9A\u3059\u308B\u3068<b>\u3059\u3079\u3066\u306E</b>\u30EA\u30C6\u30E9\u30EB\u5DEE\u304C\u7121\u8996\u3055\u308C\u307E\u3059\uFF08<code class="vg-mcode">'A'</code> \u3068 <code class="vg-mcode">'B'</code> \u306E\u5DEE\u3082\u6D88\u3048\u307E\u3059\uFF09\u3002<br>\u7279\u5B9A\u306E\u5024\u3060\u3051\u540C\u4E00\u8996\u3057\u305F\u3044\u306A\u3089\u3001<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code> \u306E\u3088\u3046\u306B\u7D44\u3067\u4E26\u3079\u307E\u3059\uFF08<code class="vg-mcode">"suffix"</code> \u306F\u305D\u306E View \u81EA\u8EAB\u306E suffix \u3092\u8868\u3059\u4E88\u7D04\u8A9E\uFF09\u3002</div>`:""}<div class="vg-pblock"><table class="vg-ptable">${n}</table></div></details>`:""}function paramsTable(e){return`<details class="vg-params"><summary class="vg-psummary">\u30D1\u30E9\u30E1\u30FC\u30BF\u5316\u3057\u305F\u7B87\u6240\uFF08\u30B0\u30EB\u30FC\u30D7\u5185\u3067\u7570\u306A\u308B\u30C8\u30FC\u30AF\u30F3\uFF09</summary>${e.map(n=>{if(!n.params.length)return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(n))}</div><div class="vg-pnone">\u5DEE\u5206\u306A\u3057\uFF08\u5B8C\u5168\u4E00\u81F4\uFF09</div></div>`;const s=n.params.map(r=>{const i=Object.entries(r.values).map(([o,a])=>`<div class="vg-pv"><span class="vg-psuf">${esc(o)}</span>${esc(a)}</div>`).join("");return`<tr><th class="vg-pname">${esc(r.name)}</th><td class="vg-pvals">${i}</td></tr>`}).join("");return`<div class="vg-pblock"><div class="vg-plabel">${esc(label(n))}</div><table class="vg-ptable">${s}</table></div>`}).join("")}</details>`}function pair(e,t,n){return relabelPanes(renderFragment2(label(e),label(t),build2Way(splitLines(e.sql),splitLines(t.sql)),n),[`\u57FA\u6E96 / ${paneSub(e)}`,paneSub(t)])}function baseTab(e){return`<span class="vg-tab vg-tbase"><span class="vg-tbadge">\u57FA\u6E96</span>${esc(label(e))}<span class="vg-tabn">${e.members.length}</span></span>`}function tabs(e,t,n){const[s,...r]=e,i=r.slice(0,MAX_TABS),o=i.map((f,u)=>`<input class="vg-r vg-r${u+1}" type="radio" name="${n}" id="${n}-${u+1}"${u===0?" checked":""}>`).join(""),a=baseTab(s)+i.map((f,u)=>`<label class="vg-tab vg-t${u+1}" for="${n}-${u+1}">${esc(label(f))}<span class="vg-tabn">${f.members.length}</span></label>`).join(""),l=i.length?i.map((f,u)=>`<div class="vg-panel vg-p${u+1}">${pair(s,f,t)}</div>`).join(""):`<div class="vg-single">${renderFragment1(label(s),paneSub(s),splitLines(s.sql),t)}</div>`;return(r.length>i.length?notice(`\u30B0\u30EB\u30FC\u30D7\u304C\u591A\u3044\u305F\u3081\u5148\u982D ${MAX_TABS} \u4EF6\u306E\u307F\u30BF\u30D6\u8868\u793A\u3057\u3066\u3044\u307E\u3059\uFF08\u5168 ${r.length} \u4EF6\uFF09\u3002`):"")+`<div class="vg-tabs">${o}<div class="vg-tablist">${a}</div><div class="vg-panels">${l}</div></div>`}function renderBase(e,t){const n=t||{},s=e.groups,r=s.length,i="vgt"+hashId(e.base+"|"+s.map(label).join("|"));let o;return r===0?o=notice("View \u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002"):o=(r>1?"":notice(e.unmatched?"suffix \u3092\u8A8D\u8B58\u3067\u304D\u306A\u304B\u3063\u305F View \u3067\u3059\u3002\u6BD4\u8F03\u76F8\u624B\u304C\u306A\u3044\u306E\u3067\u5358\u72EC\u3067\u8868\u793A\u3057\u3066\u3044\u307E\u3059\u3002":`${e.viewCount} View \u3059\u3079\u3066\u304C\u540C\u4E00\u30ED\u30B8\u30C3\u30AF\u3067\u3059\u3002\u6BD4\u8F03\u306E\u5FC5\u8981\u304C\u306A\u3044\u306E\u3067 SQL \u3060\u3051\u51FA\u3057\u3066\u3044\u307E\u3059\u3002`))+tabs(s,n,i),'<div class="vg-root">'+header(e.base,e.viewCount,r,e.unmatched)+o+missTable(s)+paramsTable(s)+"</div>"}function chromeCss(){const e=[".vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}",".vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}",".vg-title{font:600 15px/1.6 inherit;color:#1A1A1A}",".vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}",".vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;border-radius:4px;background:#F6F8FA;color:#57606A}",".vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}",".vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}",".vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}",".vg-tab:hover{background:#EAEEF2;color:#24292F}",".vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}",".vg-tbase:hover{background:#fbeded;color:#24292F}",".vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}",".vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}",".vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}",".vg-panel{display:none}",".vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}",".vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}",".vg-pblock{padding:0 12px 10px}",".vg-plabel{font:600 12px/1.8 inherit;color:#24292F}",".vg-pnone{color:#57606A;font-size:12px}",".vg-ptable{border-collapse:collapse;width:100%}",".vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-pvals{padding:3px 0}",".vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}",".vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}",".vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}",".vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;font:600 12px/1.6 inherit;color:#24292F;white-space:nowrap}",".vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}",".vg-mreason{padding:3px 0;color:#57606A;font-size:12px}",".vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}",".vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}"];for(let t=1;t<=MAX_TABS;t++)e.push(`.vg-r${t}:checked ~ .vg-panels > .vg-p${t}{display:block}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t}{background:#fff;border-color:#D0D7DE;color:#24292F}`),e.push(`.vg-r${t}:checked ~ .vg-tablist > .vg-t${t} .vg-tabn{background:#DDF4FF;color:#0969DA}`);return e.join(`
`)}function __opts(e){if(!e)return{};try{return JSON.parse(e)||{}}catch(t){return{}}}function __notice(e){return'<div class="vg-notice">'+String(e).replace(/[<>&]/g,"")+"</div>"}function __hashClass(e){for(var t=2166136261,n=0;n<e.length;n++)t^=e.charCodeAt(n),t=Math.imul(t,16777619)>>>0;return"d"+t.toString(36)}function __split(e){var t={},n=e.replace(/ style="([^"]*)"/g,function(s,r){var i=__hashClass(r);return t[i]=r,' class="'+i+'"'});return{markup:n,rules:t}}function __rulesToCss(e){for(var t=Object.keys(e).sort(),n=[],s=0;s<t.length;s++)n.push("."+t[s]+"{"+e[t[s]]+"}");return n.join(`
`)}function __applyMode(e,t){if(t==="class")return __split(e).markup;if(t==="embed"){var n=__split(e);return`<style>
`+chromeCss()+`
`+__rulesToCss(n.rules)+`
</style>
`+n.markup}return e}function __fixtureRules(e){var t={};function n(d){for(var p=analyze(d,e),h=0;h<p.bases.length;h++){var x=__split(renderBase(p.bases[h],e)).rules;for(var b in x)t[b]=x[b]}}function s(d,p){return{view_name:"v_fixture_"+d,ddl:p}}var r=`SELECT
  a,
  b
FROM t_SUF
WHERE x = 1`,i=`SELECT
  a,
  c.b
FROM t_SUF
LEFT JOIN u_SUF AS c USING (a)
WHERE x = 1`,o=`SELECT
  a
FROM t_SUF
WHERE x = 1`,a=`SELECT
  a,
  b,
  d
FROM t_SUF
WHERE x = 1`;function l(d,p){return d.replace(/SUF/g,p)}n([s("abjp",l(r,"abjp")),s("abus",l(r,"abus"))]),n([s("abjp",l(r,"abjp")),s("cdjp",l(i,"cdjp"))]),n([s("abjp",l(r,"abjp")),s("cdjp",l(i,"cdjp")),s("efjp",l(o,"efjp")),s("ghjp",l(a,"ghjp"))]),n([{view_name:"v_fixture_no_suffix",ddl:l(r,"x")}]);var c={};for(var f in e)c[f]=e[f];c.layout="panes";var u=e;return e=c,n([s("abjp",l(r,"abjp")),s("cdjp",l(i,"cdjp")),s("efjp",l(o,"efjp"))]),e=u,t}var __o=__opts(options_json);return!__o.suffixParts&&!__o.suffixList&&!__o.suffixPattern&&(__o.suffixParts=[["ab","cd","ef","gh"],["jp","us","uk"]]),chromeCss()+`
`+__rulesToCss(__fixtureRules(__o));

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
SET udf_info_function_name =
  udf_name_prefix || 'viewlgc_' || 'group_info' || udf_name_suffix;
SET udf_css_function_name =
  udf_name_prefix || 'viewlgc_' || 'group_css' || udf_name_suffix;
SET udf_render_function_name =
  udf_name_prefix || 'viewlgc_' || 'render_dynamic_sql' || udf_name_suffix;
ASSERT REGEXP_CONTAINS(udf_info_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_info_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_css_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_css_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';
ASSERT REGEXP_CONTAINS(udf_render_function_name, r'^[A-Za-z0-9_]+$') AS
  'udf_render_function_name が不正です（ルーチン名に使えるのは英数字と _ だけ。- は不可）。';


-- ---------------------------------------------------------------------
-- 1. viewlgc_group_info
--    base 1 件分の View 群を渡すと、比較 HTML とメタデータを返す
--
-- 引数:
--   views         ARRAY<STRUCT<view_name STRING, ddl STRING>>
--                 同じ base を持つ View を全部渡す
--   options_json  NULL または '{}' で既定
--
-- 戻り値 STRUCT:
--   view_count       FLOAT64        渡された View 数
--   group_count      FLOAT64        ロジックのグループ数（1 なら全部同一＝正常）
--   group_labels     ARRAY<STRING>  ["abjp, abuk, abus", …] タブ / ペイン見出し
--   group_sizes      ARRAY<FLOAT64> 各グループの View 数
--   suffixes         ARRAY<STRING>  認識した suffix 一覧
--   unmatched_count  FLOAT64        suffix を認識できなかった数
--   html             STRING         比較 HTML
--   （数値が FLOAT64 なのは JS UDF が INT64 を扱えないため。SQL 側で CAST する）
--
-- options_json のキー:
--   suffixParts   [["ab","cd","ef"],["jp","us","uk"]] のような区分の並び
--   suffixList    既知の suffix 一覧
--   suffixPattern 正規表現（既定は末尾の _ + 1〜6 文字）
--   substitutable 同一ロジックとみなす際に置換を許すトークン種別
--                 既定 ["ident","quoted"]。リテラル差も無視するなら
--                 ["ident","quoted","number","string"]
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
RETURNS STRUCT<
  view_count      FLOAT64,
  group_count     FLOAT64,
  group_labels    ARRAY<STRING>,
  group_sizes     ARRAY<FLOAT64>,
  suffixes        ARRAY<STRING>,
  unmatched_count FLOAT64,
  html            STRING
>
LANGUAGE js AS %s
''',
  udf_project_id, udf_dataset, udf_info_function_name,
  TO_JSON_STRING(js_info));


-- ---------------------------------------------------------------------
-- 2. viewlgc_group_css
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
-- 3. viewlgc_render_dynamic_sql
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
--   __UDF_INFO__           group_info 関数（project.dataset.function）
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
    diff_hist     STRING,
    diff_latest   STRING,
    info_function STRING,
    css_function  STRING
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
    sql_template,
    '__TARGET_PROJECT__', target_project_id),
    '__JOB_REGION__', job_region),
    '__T_DIFF_HIST__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_hist),
    '__V_DIFF__',
      work_project_id || '.' || work_dataset || '.' || objects.diff_latest),
    '__UDF_INFO__',
      udf_project_id || '.' || udf_dataset || '.' || objects.info_function),
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
  udf_project_id, udf_dataset, udf_render_function_name);


-- 作った 3 つの名前を出す。build_table.sql に同じ値を入れる。
SELECT
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_info_function_name)   AS info_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_css_function_name)    AS css_function,
  FORMAT('%s.%s.%s', udf_project_id, udf_dataset, udf_render_function_name) AS render_function,
  CURRENT_TIMESTAMP() AS created_at;
END;
