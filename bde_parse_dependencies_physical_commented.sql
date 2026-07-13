-- ============================================================================
-- BDE: BigQuery Dependency Engine
-- 物理カラム展開対応・詳細コメント版
--
-- このSQLは、BigQueryのView定義SQLをJavaScript UDFで解析し、
-- Viewの出力列やWHERE/JOIN/GROUP BYなどで利用されているカラムを抽出したうえで、
-- CTEを再帰的にたどり、可能な限り最終的な物理テーブル・物理カラムまで展開します。
--
-- 全体の処理フロー
--
--   SQL文字列
--      ↓
--   Lexer（文字列をToken配列へ分解）
--      ↓
--   Clause Parser（SELECT/FROM/WHEREなどの範囲を認識）
--      ↓
--   SELECT/FROM/Expression Parser
--      ↓
--   Query Scope解析
--      ├─ CTE
--      ├─ ネストしたWITH
--      ├─ スカラーサブクエリ
--      ├─ 相関サブクエリ
--      └─ UNION / EXCEPT / INTERSECT
--      ↓
--   直接依存の抽出
--      ↓
--   CTE出力列 → 内部依存の辞書化
--      ↓
--   物理テーブル・物理カラムまで再帰展開
--      ↓
--   ARRAY<STRUCT<...>>としてBigQueryへ返却
--
-- JavaScriptを読む際の基本事項
--
--   const x = ...
--     再代入しない変数を宣言します。
--
--   let x = ...
--     後で値を変更する変数を宣言します。
--
--   array.push(value)
--     配列の末尾に要素を追加します。
--
--   array.map(...)
--     各要素を変換して、新しい配列を作ります。
--
--   array.filter(...)
--     条件を満たす要素だけを残した、新しい配列を作ります。
--
--   array.find(...)
--     条件を最初に満たす要素を1件返します。
--
--   array.slice(start, end)
--     start以上、end未満の範囲を新しい配列として返します。
--
--   ...array
--     配列の要素を展開する「スプレッド構文」です。
--
--   {...object, key: value}
--     既存オブジェクトを複製し、一部の項目を上書きします。
--
--   new Set()
--     重複しない値を保持する集合です。
--
--   new Map()
--     keyとvalueの対応表です。CTE名やSource aliasの解決に利用します。
--
--   condition ? value1 : value2
--     三項演算子です。conditionがtrueならvalue1、falseならvalue2を返します。
--
-- 重要な設計ルール
--
--   1. 配列のindexは0始まりです。
--   2. token_seqは1始まりの論理番号です。
--   3. indexは配列走査用、token_seqはSQL中の位置識別用として分けています。
--   4. paren_depthは括弧の深さです。トップレベルは0です。
--   5. CTEの依存は、CTE名と出力列名をキーにして物理依存まで展開します。
--   6. 再帰CTEの循環はSetで検知し、無限ループを防ぎます。
-- ============================================================================

-- ============================================================================
-- UDF返却項目
--
-- dependency_seq
--   返却配列内の表示用連番です。
--
-- query_name
--   依存が見つかったQueryの識別名です。
--   MAIN、CTE:xxx、SCALAR_n、SET_nなどを含みます。
--
-- cte_name
--   CTE内部で見つかった依存の場合、そのCTE名です。
--
-- scope_level
--   Queryネストの深さです。メインQueryは0です。
--
-- reference_scope
--   LOCAL / OUTER / UNRESOLVEDのいずれかです。
--
-- scope_distance
--   OUTER参照の場合に、何階層外側のScopeかを示します。
--
-- output_column
--   影響を受けるView/Query出力列名です。
--   WHEREやJOINなどView全体への依存はNULLになる場合があります。
--
-- expression
--   依存が見つかった元の式です。
--
-- usage_type
--   PROJECTION / FILTER / JOIN / GROUP_KEY / HAVING /
--   QUALIFY / WINDOW_PARTITION / WINDOW_ORDERなどです。
--
-- source_alias
--   SQL内で使われたSource aliasです。
--
-- immediate_source_*
--   直接参照していたSource情報です。
--   CTE参照の場合、ここにはCTE名とCTE列名が入ります。
--
-- source_*
--   CTE展開後の最終Source情報です。
--   解決できた場合、物理テーブル名・物理カラム名が入ります。
--
-- lineage_path
--   出力列から物理カラムへ至る経路を文字列で保持します。
--
-- expansion_status
--   PHYSICAL / CTE_EXPANDED / RECURSIVE_CYCLE /
--   UNRESOLVED_CTE_COLUMNなど、展開結果を示します。
--
-- start_token_seq / end_token_seq
--   元SQL中で依存が見つかったToken範囲です。
--
-- resolution_status / resolution_reason
--   Source解決結果と、未解決時の理由です。
-- ============================================================================

CREATE TEMP FUNCTION parse_dependencies_physical(sql_text STRING)
RETURNS ARRAY<STRUCT<
  dependency_seq INT64,
  query_name STRING,
  cte_name STRING,
  scope_level INT64,
  reference_scope STRING,
  scope_distance INT64,
  output_column STRING,
  expression STRING,
  usage_type STRING,
  source_alias STRING,
  immediate_source_name STRING,
  immediate_source_type STRING,
  immediate_source_column STRING,
  source_name STRING,
  source_type STRING,
  source_column STRING,
  lineage_path STRING,
  expansion_status STRING,
  start_token_seq INT64,
  end_token_seq INT64,
  resolution_status STRING,
  resolution_reason STRING
>>
LANGUAGE js
AS r"""
/* ============================================================
 * Lexer
 * ============================================================ */

/*
 * 関数: tokenize
 * 目的:
 *   SQL文字列を左から1文字ずつ読み取り、Tokenオブジェクトの配列へ分解します。
 *
 * 引数:
 *   sqlText: 解析対象のSQL全文
 *
 * 戻り値:
 *   [
 *     {
 *       token_seq,          // SQL全体におけるTokenの論理連番（1始まり）
 *       line_no,            // Token開始行
 *       column_no,          // Token開始列
 *       token,              // 元の文字列
 *       normalized_token,   // 比較用の正規化文字列。通常は大文字
 *       token_type,         // KEYWORD / IDENTIFIER / STRINGなど
 *       paren_depth         // Token出現時点の括弧深度
 *     },
 *     ...
 *   ]
 *
 * 主な処理:
 *   1. 空白を読み飛ばす
 *   2. コメントを1Tokenとして取得
 *   3. バッククォート識別子を取得
 *   4. 文字列リテラルを取得
 *   5. キーワードまたは識別子を取得
 *   6. 数値を取得
 *   7. 演算子と記号を取得
 *
 * 注意:
 *   "(" 自身には、括弧を開く前のparen_depthが入ります。
 *   ")" 自身には、括弧を閉じる前のparen_depthが入ります。
 *   この仕様を利用して対応する閉じ括弧を検索しています。
 */
function tokenize(sqlText) {
  const tokens = [];
  let tokenSeq = 0;
  let line = 1;
  let column = 1;
  let parenDepth = 0;
  let index = 0;

  const KEYWORDS = new Set([
    "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "QUALIFY",
    "ORDER", "LIMIT", "JOIN", "LEFT", "RIGHT", "FULL", "INNER",
    "OUTER", "CROSS", "ON", "USING", "WITH", "RECURSIVE", "AS",
    "UNION", "ALL", "DISTINCT", "AND", "OR", "NOT", "IN", "IS",
    "NULL", "TRUE", "FALSE", "CASE", "WHEN", "THEN", "ELSE", "END",
    "OVER", "PARTITION", "UNNEST", "STRUCT", "ARRAY", "EXCEPT",
    "REPLACE", "INTERSECT", "OFFSET", "ORDINAL", "ASC", "DESC",
    "ROWS", "RANGE", "GROUPS", "NULLS", "FIRST", "LAST", "BETWEEN",
    "PRECEDING", "FOLLOWING", "CURRENT", "ROW"
  ]);

  const SYMBOLS = new Set(["(", ")", ",", ".", ";", "[", "]"]);
  const SINGLE_OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "<", ">", "!"]);
  const DOUBLE_OPERATORS = new Set([">=", "<=", "!=", "<>", "||"]);

  /*
   * tokenize内部関数: pushToken
   * 読み取り終えた1Tokenをtokens配列へ追加します。
   *
   * ++tokenSeq:
   *   先にtokenSeqへ1を足し、その値をtoken_seqへ設定します。
   */
  function pushToken(token, normalizedToken, tokenType, tokenLine, tokenColumn) {
    tokens.push({
      token_seq: ++tokenSeq,
      line_no: tokenLine,
      column_no: tokenColumn,
      token: token,
      normalized_token: normalizedToken,
      token_type: tokenType,
      paren_depth: parenDepth
    });
  }

  function isSpace(character) {
    return /\s/.test(character);
  }

  function isIdentifierStart(character) {
    return /[A-Za-z_]/.test(character);
  }

  function isIdentifierPart(character) {
    return /[A-Za-z0-9_$]/.test(character);
  }

  function isDigit(character) {
    return /[0-9]/.test(character);
  }

  /*
   * tokenize内部関数: advanceCharacter
   * 現在文字を1文字消費し、index・行番号・列番号を更新します。
   */
  function advanceCharacter(character) {
    if (character === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    index++;
  }

  /*
   * SQL文字列を先頭から末尾まで1文字ずつ処理します。
   * indexは現在読み取っている文字位置です。
   */
  while (index < sqlText.length) {
    const character = sqlText[index];

    if (isSpace(character)) {
      advanceCharacter(character);
      continue;
    }

    const startLine = line;
    const startColumn = column;

    if (character === "-" && sqlText[index + 1] === "-") {
      let value = "";
      while (index < sqlText.length && sqlText[index] !== "\n") {
        const currentCharacter = sqlText[index];
        value += currentCharacter;
        advanceCharacter(currentCharacter);
      }
      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    if (character === "/" && sqlText[index + 1] === "*") {
      let value = "";
      while (index < sqlText.length) {
        const currentCharacter = sqlText[index];
        value += currentCharacter;

        if (currentCharacter === "*" && sqlText[index + 1] === "/") {
          advanceCharacter(currentCharacter);
          const closingSlash = sqlText[index];
          value += closingSlash;
          advanceCharacter(closingSlash);
          break;
        }

        advanceCharacter(currentCharacter);
      }
      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    if (character === "`") {
      let value = character;
      advanceCharacter(character);

      while (index < sqlText.length) {
        const currentCharacter = sqlText[index];
        value += currentCharacter;
        advanceCharacter(currentCharacter);
        if (currentCharacter === "`") break;
      }

      const normalizedValue =
        value.length >= 2 ? value.substring(1, value.length - 1) : value;

      pushToken(
        value,
        normalizedValue,
        "BACKTICK_IDENTIFIER",
        startLine,
        startColumn
      );
      continue;
    }

    if (character === "'" || character === '"') {
      const quoteCharacter = character;
      let value = character;
      advanceCharacter(character);

      while (index < sqlText.length) {
        const currentCharacter = sqlText[index];
        value += currentCharacter;
        advanceCharacter(currentCharacter);

        if (
          currentCharacter === quoteCharacter &&
          sqlText[index] === quoteCharacter
        ) {
          const escapedQuote = sqlText[index];
          value += escapedQuote;
          advanceCharacter(escapedQuote);
          continue;
        }

        if (currentCharacter === quoteCharacter) break;
      }

      const normalizedValue =
        value.length >= 2 ? value.substring(1, value.length - 1) : value;

      pushToken(value, normalizedValue, "STRING", startLine, startColumn);
      continue;
    }

    if (isIdentifierStart(character)) {
      let value = "";

      while (
        index < sqlText.length &&
        isIdentifierPart(sqlText[index])
      ) {
        const currentCharacter = sqlText[index];
        value += currentCharacter;
        advanceCharacter(currentCharacter);
      }

      const normalizedValue = value.toUpperCase();
      const tokenType =
        KEYWORDS.has(normalizedValue) ? "KEYWORD" : "IDENTIFIER";

      pushToken(value, normalizedValue, tokenType, startLine, startColumn);
      continue;
    }

    if (isDigit(character)) {
      let value = "";

      while (
        index < sqlText.length &&
        /[0-9.]/.test(sqlText[index])
      ) {
        const currentCharacter = sqlText[index];
        value += currentCharacter;
        advanceCharacter(currentCharacter);
      }

      pushToken(value, value, "NUMBER", startLine, startColumn);
      continue;
    }

    const twoCharacters = sqlText.substring(index, index + 2);

    if (DOUBLE_OPERATORS.has(twoCharacters)) {
      pushToken(
        twoCharacters,
        twoCharacters,
        "OPERATOR",
        startLine,
        startColumn
      );
      advanceCharacter(sqlText[index]);
      advanceCharacter(sqlText[index]);
      continue;
    }

    if (SYMBOLS.has(character)) {
      pushToken(
        character,
        character,
        "SYMBOL",
        startLine,
        startColumn
      );

      if (character === "(" || character === "[") {
        parenDepth++;
      } else if (character === ")" || character === "]") {
        parenDepth--;
      }

      advanceCharacter(character);
      continue;
    }

    if (SINGLE_OPERATORS.has(character)) {
      pushToken(
        character,
        character,
        "OPERATOR",
        startLine,
        startColumn
      );
      advanceCharacter(character);
      continue;
    }

    pushToken(
      character,
      character,
      "UNKNOWN",
      startLine,
      startColumn
    );
    advanceCharacter(character);
  }

  return tokens;
}


/* ============================================================
 * Common helpers
 * ============================================================ */

/*
 * 関数: normalizedTokenAt
 * 目的:
 *   指定indexのTokenからnormalized_tokenを安全に取得します。
 *   配列範囲外の場合は空文字を返すため、次Token確認時の例外を防げます。
 */
function normalizedTokenAt(tokens, index) {
  const token = tokens[index];
  return token ? (token.normalized_token || "") : "";
}

/*
 * 関数: sliceTokensBySequence
 * 目的:
 *   token_seqの開始・終了範囲に含まれるTokenだけを抽出します。
 *
 * 注意:
 *   JavaScript配列のindexではなく、Lexerが付けたtoken_seqを基準にします。
 *   endSequenceは「含む」条件です。
 */
function sliceTokensBySequence(tokens, startSequence, endSequence) {
  return tokens.filter(
    (token) =>
      token.token_seq >= startSequence &&
      token.token_seq <= endSequence
  );
}

/*
 * 関数: removeCommentTokens
 * 目的:
 *   COMMENT Tokenをすべて除外した新しい配列を返します。
 *   元の配列自体は変更しません。
 */
function removeCommentTokens(tokens) {
  return tokens.filter(
    (token) => token.token_type !== "COMMENT"
  );
}

/*
 * 関数: trimCommentTokens
 * 目的:
 *   配列の先頭と末尾にあるCOMMENT Tokenだけを取り除きます。
 *   式の途中にあるコメントは保持します。
 *
 * JavaScriptポイント:
 *   tokens.slice(startIndex, endIndex + 1) のendは未満なので、+1しています。
 */
function trimCommentTokens(tokens) {
  let startIndex = 0;
  let endIndex = tokens.length - 1;

  while (
    startIndex <= endIndex &&
    tokens[startIndex].token_type === "COMMENT"
  ) {
    startIndex++;
  }

  while (
    endIndex >= startIndex &&
    tokens[endIndex].token_type === "COMMENT"
  ) {
    endIndex--;
  }

  return tokens.slice(startIndex, endIndex + 1);
}

/*
 * 関数: tokensToText
 * 目的:
 *   Token配列を、人が読めるSQL断片の文字列へ戻します。
 *
 * 空白を入れない例:
 *   table.column
 *   function(argument)
 *
 * 空白を入れる例:
 *   amount + tax
 *   CASE WHEN ...
 */
function tokensToText(tokens) {
  let result = "";

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const currentToken = tokens[tokenIndex];
    const previousToken = tokens[tokenIndex - 1];

    if (!previousToken) {
      result += currentToken.token;
      continue;
    }

    const noSpaceBefore =
      currentToken.token === "." ||
      currentToken.token === "," ||
      currentToken.token === ")" ||
      currentToken.token === "]";

    const noSpaceAfterPrevious =
      previousToken.token === "." ||
      previousToken.token === "(" ||
      previousToken.token === "[";

    if (noSpaceBefore || noSpaceAfterPrevious) {
      result += currentToken.token;
    } else {
      result += " " + currentToken.token;
    }
  }

  return result;
}

/*
 * 関数: isIdentifierToken
 * 目的:
 *   Tokenが通常識別子またはバッククォート識別子か判定します。
 *
 * 例:
 *   customer_id                  → IDENTIFIER
 *   `project.dataset.table`      → BACKTICK_IDENTIFIER
 */
function isIdentifierToken(token) {
  if (!token) return false;

  return (
    token.token_type === "IDENTIFIER" ||
    token.token_type === "BACKTICK_IDENTIFIER"
  );
}

/*
 * 関数: findMatchingCloseParenthesis
 * 目的:
 *   指定された"("に対応する")"の配列indexを探します。
 *
 * 判定方法:
 *   開き括弧のparen_depth + 1 と同じdepthを持つ閉じ括弧を検索します。
 *
 * 戻り値:
 *   見つかった場合: 閉じ括弧のindex
 *   見つからない場合: -1
 */
function findMatchingCloseParenthesis(tokens, openParenthesisIndex) {
  const openParenthesis = tokens[openParenthesisIndex];

  if (!openParenthesis || openParenthesis.token !== "(") {
    return -1;
  }

  const closingDepth = openParenthesis.paren_depth + 1;

  for (
    let tokenIndex = openParenthesisIndex + 1;
    tokenIndex < tokens.length;
    tokenIndex++
  ) {
    const currentToken = tokens[tokenIndex];

    if (
      currentToken.token === ")" &&
      currentToken.paren_depth === closingDepth
    ) {
      return tokenIndex;
    }
  }

  return -1;
}


/* ============================================================
 * Clause parser
 * ============================================================ */

/*
 * 関数: detectClause
 * 目的:
 *   指定位置からSELECT/FROM/WHERE/GROUP BYなどのClause開始を判定します。
 *
 * 戻り値例:
 *   { clause: "GROUP_BY", token_length: 2 }
 *
 * token_length:
 *   GROUP BYやORDER BYのように、Clause名が複数Tokenで構成される場合に使います。
 */
function detectClause(tokens, index) {
  const firstToken = normalizedTokenAt(tokens, index);
  const secondToken = normalizedTokenAt(tokens, index + 1);

  if (firstToken === "SELECT") return { clause: "SELECT", token_length: 1 };
  if (firstToken === "FROM") return { clause: "FROM", token_length: 1 };
  if (firstToken === "WHERE") return { clause: "WHERE", token_length: 1 };
  if (firstToken === "HAVING") return { clause: "HAVING", token_length: 1 };
  if (firstToken === "QUALIFY") return { clause: "QUALIFY", token_length: 1 };
  if (firstToken === "LIMIT") return { clause: "LIMIT", token_length: 1 };

  if (firstToken === "GROUP" && secondToken === "BY") {
    return { clause: "GROUP_BY", token_length: 2 };
  }

  if (firstToken === "ORDER" && secondToken === "BY") {
    return { clause: "ORDER_BY", token_length: 2 };
  }

  return null;
}

/*
 * 関数: parseClauses
 * 目的:
 *   Queryのトップレベルに存在する各Clauseの範囲を求めます。
 *
 * 出力例:
 *   {
 *     clause: "SELECT",
 *     clause_start_seq: 1,
 *     body_start_seq: 2,
 *     body_end_seq: 15
 *   }
 *
 * 重要:
 *   paren_depth === 0 のClauseだけを対象にします。
 *   そのため、スカラーサブクエリ内部のFROMなどを外側QueryのClauseと誤認しません。
 */
function parseClauses(tokens) {
  const clauses = [];
  const effectiveTokens = removeCommentTokens(tokens);

  for (
    let tokenIndex = 0;
    tokenIndex < effectiveTokens.length;
    tokenIndex++
  ) {
    const currentToken = effectiveTokens[tokenIndex];

    if (currentToken.paren_depth !== 0) continue;

    const detectedClause =
      detectClause(effectiveTokens, tokenIndex);

    if (!detectedClause) continue;

    clauses.push({
      clause_seq: clauses.length + 1,
      clause: detectedClause.clause,
      clause_start_seq: currentToken.token_seq,
      body_start_seq:
        currentToken.token_seq + detectedClause.token_length,
      body_end_seq: null
    });
  }

  for (
    let clauseIndex = 0;
    clauseIndex < clauses.length;
    clauseIndex++
  ) {
    const currentClause = clauses[clauseIndex];
    const nextClause = clauses[clauseIndex + 1];

    if (nextClause) {
      currentClause.body_end_seq =
        nextClause.clause_start_seq - 1;
    } else if (effectiveTokens.length > 0) {
      const lastToken =
        effectiveTokens[effectiveTokens.length - 1];

      currentClause.body_end_seq =
        lastToken.token_seq;
    }
  }

  return clauses;
}


/* ============================================================
 * SELECT parser
 * ============================================================ */

/*
 * 関数: splitTopLevelByComma
 * 目的:
 *   指定depthにあるカンマだけを区切りとして、Token配列を複数の式へ分割します。
 *
 * 例:
 *   a, SUM(b), IF(x, y, z)
 *
 * 分割結果:
 *   [a]
 *   [SUM(b)]
 *   [IF(x, y, z)]
 *
 * IF内部のカンマはdepthが深いため分割対象になりません。
 */
function splitTopLevelByComma(tokens, targetDepth) {
  const result = [];
  let currentItemTokens = [];

  for (const currentToken of tokens) {
    const isTopLevelComma =
      currentToken.token === "," &&
      currentToken.paren_depth === targetDepth;

    if (isTopLevelComma) {
      const completedItem =
        trimCommentTokens(currentItemTokens);

      if (completedItem.length > 0) {
        result.push(completedItem);
      }

      currentItemTokens = [];
      continue;
    }

    currentItemTokens.push(currentToken);
  }

  const lastItem =
    trimCommentTokens(currentItemTokens);

  if (lastItem.length > 0) {
    result.push(lastItem);
  }

  return result;
}

/*
 * 関数: parseSelectAlias
 * 目的:
 *   SELECT項目から式本体と出力列名を分離します。
 *
 * 対応:
 *   c.customer_id                  → CUSTOMER_ID
 *   SUM(amount) AS total_amount    → TOTAL_AMOUNT
 *   SUM(amount) total_amount       → TOTAL_AMOUNT
 *
 * alias_type:
 *   EXPLICIT_AS    : ASあり
 *   IMPLICIT       : AS省略
 *   DERIVED_COLUMN : 元カラム名を出力名として採用
 *   NONE           : 出力名を決定できない
 */
function parseSelectAlias(itemTokens) {
  if (itemTokens.length === 0) {
    return {
      expression_tokens: [],
      expression: "",
      output_alias: null,
      alias_type: "NONE"
    };
  }

  for (
    let tokenIndex = itemTokens.length - 2;
    tokenIndex >= 0;
    tokenIndex--
  ) {
    const currentToken = itemTokens[tokenIndex];

    if (
      currentToken.normalized_token === "AS" &&
      currentToken.paren_depth === 0
    ) {
      const aliasToken = itemTokens[tokenIndex + 1];
      const expressionTokens =
        itemTokens.slice(0, tokenIndex);

      return {
        expression_tokens: expressionTokens,
        expression: tokensToText(expressionTokens),
        output_alias:
          aliasToken ? aliasToken.normalized_token : null,
        alias_type: "EXPLICIT_AS"
      };
    }
  }

  if (itemTokens.length >= 3) {
    const dotToken =
      itemTokens[itemTokens.length - 2];

    const columnToken =
      itemTokens[itemTokens.length - 1];

    if (
      dotToken.token === "." &&
      isIdentifierToken(columnToken)
    ) {
      return {
        expression_tokens: itemTokens,
        expression: tokensToText(itemTokens),
        output_alias: columnToken.normalized_token,
        alias_type: "DERIVED_COLUMN"
      };
    }
  }

  if (
    itemTokens.length === 1 &&
    isIdentifierToken(itemTokens[0])
  ) {
    return {
      expression_tokens: itemTokens,
      expression: tokensToText(itemTokens),
      output_alias: itemTokens[0].normalized_token,
      alias_type: "DERIVED_COLUMN"
    };
  }

  const lastToken =
    itemTokens[itemTokens.length - 1];

  const previousToken =
    itemTokens[itemTokens.length - 2];

  if (
    itemTokens.length >= 2 &&
    isIdentifierToken(lastToken) &&
    previousToken &&
    previousToken.token !== "."
  ) {
    const expressionTokens =
      itemTokens.slice(0, itemTokens.length - 1);

    return {
      expression_tokens: expressionTokens,
      expression: tokensToText(expressionTokens),
      output_alias: lastToken.normalized_token,
      alias_type: "IMPLICIT"
    };
  }

  return {
    expression_tokens: itemTokens,
    expression: tokensToText(itemTokens),
    output_alias: null,
    alias_type: "NONE"
  };
}

/*
 * 関数: removeSelectModifiers
 * 目的:
 *   SELECT直後のDISTINCTまたはALLをSELECT項目解析の対象から除外します。
 */
function removeSelectModifiers(selectTokens) {
  const result = selectTokens.slice();

  if (
    result.length > 0 &&
    (
      result[0].normalized_token === "DISTINCT" ||
      result[0].normalized_token === "ALL"
    )
  ) {
    result.shift();
  }

  return result;
}

/*
 * 関数: parseSelect
 * 目的:
 *   SELECT句を項目単位に分割し、式・出力alias・Token範囲を返します。
 *
 * 処理:
 *   1. SELECT本文Tokenを切り出す
 *   2. DISTINCT/ALLを除去
 *   3. トップレベルのカンマで項目分割
 *   4. 各項目のaliasを解析
 */
function parseSelect(tokens, selectClause) {
  let selectTokens =
    sliceTokensBySequence(
      tokens,
      selectClause.body_start_seq,
      selectClause.body_end_seq
    );

  selectTokens =
    removeSelectModifiers(selectTokens);

  const selectItemTokenArrays =
    splitTopLevelByComma(selectTokens, 0);

  const selectItems = [];

  for (
    let itemIndex = 0;
    itemIndex < selectItemTokenArrays.length;
    itemIndex++
  ) {
    const itemTokens =
      selectItemTokenArrays[itemIndex];

    const parsedAlias =
      parseSelectAlias(itemTokens);

    selectItems.push({
      select_item_seq: itemIndex + 1,
      expression: parsedAlias.expression,
      expression_tokens: parsedAlias.expression_tokens,
      output_alias: parsedAlias.output_alias,
      alias_type: parsedAlias.alias_type,
      start_token_seq: itemTokens[0].token_seq,
      end_token_seq:
        itemTokens[itemTokens.length - 1].token_seq
    });
  }

  return selectItems;
}


/* ============================================================
 * FROM parser
 * ============================================================ */

const JOIN_MODIFIERS = new Set([
  "LEFT", "RIGHT", "FULL", "INNER", "OUTER", "CROSS"
]);

const SOURCE_STOP_WORDS = new Set([
  "ON", "USING", "JOIN", "LEFT", "RIGHT", "FULL",
  "INNER", "OUTER", "CROSS", "WHERE", "GROUP",
  "HAVING", "QUALIFY", "ORDER", "LIMIT"
]);

/*
 * 関数: parseSourceAlias
 * 目的:
 *   FROM/JOINの参照元に付いたaliasを解析します。
 *
 * 対応例:
 *   FROM sales s
 *   FROM sales AS s
 *
 * next_index:
 *   aliasを読み終えた次の配列indexです。
 */
function parseSourceAlias(tokens, startIndex) {
  const currentToken = tokens[startIndex];

  if (!currentToken) {
    return { source_alias: null, next_index: startIndex };
  }

  if (currentToken.normalized_token === "AS") {
    const aliasToken = tokens[startIndex + 1];

    if (isIdentifierToken(aliasToken)) {
      return {
        source_alias: aliasToken.normalized_token,
        next_index: startIndex + 2
      };
    }
  }

  if (
    isIdentifierToken(currentToken) &&
    !SOURCE_STOP_WORDS.has(currentToken.normalized_token)
  ) {
    return {
      source_alias: currentToken.normalized_token,
      next_index: startIndex + 1
    };
  }

  return { source_alias: null, next_index: startIndex };
}

/*
 * 関数: parseDottedSourceName
 * 目的:
 *   project.dataset.tableのようなドット区切りの参照元名を読み取ります。
 *
 * バッククォートで囲まれた完全修飾名は1Tokenとして扱います。
 */
function parseDottedSourceName(tokens, startIndex) {
  const firstToken = tokens[startIndex];

  if (!firstToken) return null;

  if (firstToken.token_type === "BACKTICK_IDENTIFIER") {
    return {
      source_name: firstToken.normalized_token,
      source_type: "OBJECT",
      next_index: startIndex + 1,
      end_token_seq: firstToken.token_seq
    };
  }

  if (!isIdentifierToken(firstToken)) return null;

  const parts = [firstToken.token];
  let tokenIndex = startIndex + 1;
  let endToken = firstToken;

  while (
    tokenIndex + 1 < tokens.length &&
    tokens[tokenIndex].token === "." &&
    isIdentifierToken(tokens[tokenIndex + 1])
  ) {
    parts.push(tokens[tokenIndex + 1].token);
    endToken = tokens[tokenIndex + 1];
    tokenIndex += 2;
  }

  return {
    source_name: parts.join("."),
    source_type: "OBJECT",
    next_index: tokenIndex,
    end_token_seq: endToken.token_seq
  };
}

/*
 * 関数: parseSource
 * 目的:
 *   FROM/JOIN直後にある1つのSourceを解析します。
 *
 * 対応:
 *   通常テーブル/View/CTE
 *   FROM (SELECT ...) alias
 *   UNNEST(expression) alias
 */
function parseSource(tokens, startIndex) {
  const firstToken = tokens[startIndex];

  if (!firstToken) return null;

  if (firstToken.token === "(") {
    const closeIndex =
      findMatchingCloseParenthesis(tokens, startIndex);

    if (closeIndex < 0) return null;

    const subqueryTokens =
      tokens.slice(startIndex + 1, closeIndex);

    const aliasResult =
      parseSourceAlias(tokens, closeIndex + 1);

    return {
      source_type: "SUBQUERY",
      source_name: tokensToText(subqueryTokens),
      source_alias: aliasResult.source_alias,
      start_token_seq: firstToken.token_seq,
      end_token_seq: tokens[closeIndex].token_seq,
      next_index: aliasResult.next_index
    };
  }

  if (firstToken.normalized_token === "UNNEST") {
    const openIndex = startIndex + 1;

    if (
      !tokens[openIndex] ||
      tokens[openIndex].token !== "("
    ) {
      return null;
    }

    const closeIndex =
      findMatchingCloseParenthesis(tokens, openIndex);

    if (closeIndex < 0) return null;

    const unnestExpressionTokens =
      tokens.slice(openIndex + 1, closeIndex);

    const aliasResult =
      parseSourceAlias(tokens, closeIndex + 1);

    return {
      source_type: "UNNEST",
      source_name: tokensToText(unnestExpressionTokens),
      source_alias: aliasResult.source_alias,
      start_token_seq: firstToken.token_seq,
      end_token_seq: tokens[closeIndex].token_seq,
      next_index: aliasResult.next_index
    };
  }

  const dottedSource =
    parseDottedSourceName(tokens, startIndex);

  if (!dottedSource) return null;

  const aliasResult =
    parseSourceAlias(tokens, dottedSource.next_index);

  return {
    source_type: dottedSource.source_type,
    source_name: dottedSource.source_name,
    source_alias: aliasResult.source_alias,
    start_token_seq: firstToken.token_seq,
    end_token_seq: dottedSource.end_token_seq,
    next_index: aliasResult.next_index
  };
}

/*
 * 関数: detectJoin
 * 目的:
 *   JOIN / LEFT JOIN / LEFT OUTER JOIN / CROSS JOINなどを認識します。
 *
 * 戻り値のsource_start_indexは、JOIN対象Sourceの開始位置です。
 */
function detectJoin(tokens, startIndex) {
  let tokenIndex = startIndex;
  const words = [];

  while (
    tokenIndex < tokens.length &&
    JOIN_MODIFIERS.has(tokens[tokenIndex].normalized_token)
  ) {
    words.push(tokens[tokenIndex].normalized_token);
    tokenIndex++;
  }

  if (
    tokens[tokenIndex] &&
    tokens[tokenIndex].normalized_token === "JOIN"
  ) {
    words.push("JOIN");

    return {
      join_type: words.join("_"),
      source_start_index: tokenIndex + 1
    };
  }

  return null;
}

/*
 * 関数: parseFrom
 * 目的:
 *   FROM句全体から、最初のSourceと後続JOIN/カンマSourceを抽出します。
 *
 * 戻り値:
 *   Sourceの配列。各要素にsource_name、source_alias、join_typeなどを持ちます。
 */
function parseFrom(tokens, fromClause) {
  const fromTokens =
    removeCommentTokens(
      sliceTokensBySequence(
        tokens,
        fromClause.body_start_seq,
        fromClause.body_end_seq
      )
    );

  const sources = [];
  let tokenIndex = 0;

  const firstSource =
    parseSource(fromTokens, tokenIndex);

  if (firstSource) {
    sources.push({
      join_type: "FROM",
      source_type: firstSource.source_type,
      source_name: firstSource.source_name,
      source_alias: firstSource.source_alias,
      start_token_seq: firstSource.start_token_seq,
      end_token_seq: firstSource.end_token_seq
    });

    tokenIndex = firstSource.next_index;
  }

  while (tokenIndex < fromTokens.length) {
    const currentToken = fromTokens[tokenIndex];

    if (
      currentToken.token === "," &&
      currentToken.paren_depth === 0
    ) {
      const commaSource =
        parseSource(fromTokens, tokenIndex + 1);

      if (commaSource) {
        sources.push({
          join_type: "COMMA",
          source_type: commaSource.source_type,
          source_name: commaSource.source_name,
          source_alias: commaSource.source_alias,
          start_token_seq: commaSource.start_token_seq,
          end_token_seq: commaSource.end_token_seq
        });

        tokenIndex = commaSource.next_index;
        continue;
      }
    }

    const join =
      detectJoin(fromTokens, tokenIndex);

    if (join) {
      const joinedSource =
        parseSource(
          fromTokens,
          join.source_start_index
        );

      if (joinedSource) {
        sources.push({
          join_type: join.join_type,
          source_type: joinedSource.source_type,
          source_name: joinedSource.source_name,
          source_alias: joinedSource.source_alias,
          start_token_seq: joinedSource.start_token_seq,
          end_token_seq: joinedSource.end_token_seq
        });

        tokenIndex = joinedSource.next_index;
        continue;
      }
    }

    tokenIndex++;
  }

  return sources;
}


/* ============================================================
 * Expression dependency parser
 * ============================================================ */

/*
 * 関数: buildSourceAliasMap
 * 目的:
 *   Source aliasまたはテーブル短縮名からSource情報を引けるMapを作ります。
 *
 * 例:
 *   FROM project.dataset.sales AS s
 *
 *   Map:
 *     "S"     → salesのSource情報
 *     "SALES" → salesのSource情報
 */
function buildSourceAliasMap(sources) {
  const aliasMap = new Map();

  for (const source of sources) {
    if (source.source_alias) {
      aliasMap.set(
        source.source_alias.toUpperCase(),
        source
      );
    }

    if (source.source_name) {
      const sourceNameParts =
        source.source_name.split(".");

      const shortName =
        sourceNameParts[sourceNameParts.length - 1];

      if (shortName) {
        aliasMap.set(shortName.toUpperCase(), source);
      }
    }
  }

  return aliasMap;
}

/*
 * 関数: findQualifiedColumnReferences
 * 目的:
 *   expressionTokensから alias.column 形式の参照を抽出します。
 *
 * 3Token:
 *   alias / "." / column
 *
 * Source aliasがMapに存在しない場合も、UNRESOLVED_ALIASとして結果を残します。
 */
function findQualifiedColumnReferences(
  expressionTokens,
  sourceAliasMap
) {
  const references = [];

  for (
    let tokenIndex = 0;
    tokenIndex < expressionTokens.length - 2;
    tokenIndex++
  ) {
    const aliasToken = expressionTokens[tokenIndex];
    const dotToken = expressionTokens[tokenIndex + 1];
    const columnToken = expressionTokens[tokenIndex + 2];

    if (
      !isIdentifierToken(aliasToken) ||
      dotToken.token !== "." ||
      !isIdentifierToken(columnToken)
    ) {
      continue;
    }

    const sourceAlias =
      aliasToken.normalized_token;

    const source =
      sourceAliasMap.get(sourceAlias);

    references.push({
      source_alias: sourceAlias,
      source_name: source ? source.source_name : null,
      source_type: source ? source.source_type : null,
      source_cte_query_name:
        source ? (source.cte_query_name || null) : null,
      source_column: columnToken.normalized_token,
      start_token_seq: aliasToken.token_seq,
      end_token_seq: columnToken.token_seq,
      resolution_status:
        source ? "RESOLVED_SOURCE" : "UNRESOLVED_ALIAS",
      resolution_reason:
        source ? null : "SOURCE_ALIAS_NOT_FOUND"
    });

    tokenIndex += 2;
  }

  return references;
}

/*
 * 関数: collectQualifiedTokenSequences
 * 目的:
 *   alias.columnとして処理済みのtoken_seqをSetへ登録します。
 *   後続の単独カラム抽出で重複して拾わないために使います。
 */
function collectQualifiedTokenSequences(qualifiedReferences) {
  const tokenSequences = new Set();

  for (const reference of qualifiedReferences) {
    for (
      let tokenSequence = reference.start_token_seq;
      tokenSequence <= reference.end_token_seq;
      tokenSequence++
    ) {
      tokenSequences.add(tokenSequence);
    }
  }

  return tokenSequences;
}

/*
 * 関数: isFunctionName
 * 目的:
 *   現在Tokenの直後が"("なら、関数名とみなします。
 *
 * 例:
 *   SUM ( amount )
 *   ↑ SUMはカラム依存ではないため除外します。
 */
function isFunctionName(tokens, tokenIndex) {
  const currentToken = tokens[tokenIndex];
  const nextToken = tokens[tokenIndex + 1];

  return (
    isIdentifierToken(currentToken) &&
    nextToken &&
    nextToken.token === "("
  );
}

/*
 * 関数: isAliasDefinition
 * 目的:
 *   現在Tokenの直前がASか確認し、出力aliasをカラム依存として拾わないようにします。
 */
function isAliasDefinition(tokens, tokenIndex) {
  const previousToken = tokens[tokenIndex - 1];

  return (
    previousToken &&
    previousToken.normalized_token === "AS"
  );
}

/*
 * 関数: findUnqualifiedColumnReferences
 * 目的:
 *   aliasが付いていない単独カラム参照を抽出します。
 *
 * 解決ルール:
 *   Sourceが1つだけ  → そのSourceのカラムとして仮解決
 *   Sourceが複数      → AMBIGUOUS_UNQUALIFIED_COLUMN
 *   Sourceが0件       → SOURCE_NOT_FOUND
 */
function findUnqualifiedColumnReferences(
  expressionTokens,
  qualifiedTokenSequences,
  sources
) {
  const references = [];

  for (
    let tokenIndex = 0;
    tokenIndex < expressionTokens.length;
    tokenIndex++
  ) {
    const currentToken = expressionTokens[tokenIndex];

    if (!isIdentifierToken(currentToken)) continue;

    if (
      qualifiedTokenSequences.has(currentToken.token_seq)
    ) {
      continue;
    }

    if (isFunctionName(expressionTokens, tokenIndex)) {
      continue;
    }

    if (isAliasDefinition(expressionTokens, tokenIndex)) {
      continue;
    }

    if (sources.length === 1) {
      const source = sources[0];

      references.push({
        source_alias: source.source_alias,
        source_name: source.source_name,
        source_type: source.source_type,
        source_cte_query_name:
          source.cte_query_name || null,
        source_column: currentToken.normalized_token,
        start_token_seq: currentToken.token_seq,
        end_token_seq: currentToken.token_seq,
        resolution_status: "RESOLVED_SINGLE_SOURCE",
        resolution_reason: null
      });

      continue;
    }

    references.push({
      source_alias: null,
      source_name: null,
      source_type: null,
      source_cte_query_name: null,
      source_column: currentToken.normalized_token,
      start_token_seq: currentToken.token_seq,
      end_token_seq: currentToken.token_seq,
      resolution_status: "UNRESOLVED",
      resolution_reason:
        sources.length === 0
          ? "SOURCE_NOT_FOUND"
          : "AMBIGUOUS_UNQUALIFIED_COLUMN"
    });
  }

  return references;
}

/*
 * 関数: extractExpressionDependencies
 * 目的:
 *   1つの式から、修飾付きカラムと単独カラムの依存候補をまとめて抽出します。
 */
function extractExpressionDependencies(
  expressionTokens,
  sources
) {
  const sourceAliasMap =
    buildSourceAliasMap(sources);

  const qualifiedReferences =
    findQualifiedColumnReferences(
      expressionTokens,
      sourceAliasMap
    );

  const qualifiedTokenSequences =
    collectQualifiedTokenSequences(
      qualifiedReferences
    );

  const unqualifiedReferences =
    findUnqualifiedColumnReferences(
      expressionTokens,
      qualifiedTokenSequences,
      sources
    );

  return [
    ...qualifiedReferences,
    ...unqualifiedReferences
  ];
}

/*
 * 関数: buildDependenciesFromExpression
 * 目的:
 *   Expression Parserの参照結果へ、usage_typeやoutput_columnなどの
 *   リネージ用属性を付加します。
 *
 * usage_type例:
 *   PROJECTION / FILTER / JOIN / GROUP_KEY / HAVING / QUALIFY
 */
function buildDependenciesFromExpression(
  expressionTokens,
  sources,
  usageType,
  outputColumn,
  expressionText
) {
  const references =
    extractExpressionDependencies(
      expressionTokens,
      sources
    );

  const dependencies = [];

  for (const reference of references) {
    dependencies.push({
      output_column: outputColumn || null,
      expression: expressionText || null,
      usage_type: usageType,
      source_alias: reference.source_alias,
      source_name: reference.source_name,
      source_type: reference.source_type,
      source_cte_query_name:
        reference.source_cte_query_name || null,
      source_column: reference.source_column,
      start_token_seq: reference.start_token_seq,
      end_token_seq: reference.end_token_seq,
      resolution_status: reference.resolution_status,
      resolution_reason: reference.resolution_reason
    });
  }

  return dependencies;
}


/* ============================================================
 * JOIN / WHERE / GROUP BY / HAVING
 * ============================================================ */

/*
 * 関数: parseSingleExpressionClause
 * 目的:
 *   WHEREやHAVINGなど、Clause本文全体を1つの式として依存解析します。
 */
function parseSingleExpressionClause(
  tokens,
  clause,
  sources,
  usageType
) {
  if (!clause) return [];

  const expressionTokens =
    removeCommentTokens(
      sliceTokensBySequence(
        tokens,
        clause.body_start_seq,
        clause.body_end_seq
      )
    );

  return buildDependenciesFromExpression(
    expressionTokens,
    sources,
    usageType,
    null,
    tokensToText(expressionTokens)
  );
}

/*
 * 関数: parseGroupByDependencies
 * 目的:
 *   GROUP BY本文をカンマ単位に分割し、各GROUP KEYの依存を抽出します。
 */
function parseGroupByDependencies(
  tokens,
  groupByClause,
  sources
) {
  if (!groupByClause) return [];

  const groupByTokens =
    removeCommentTokens(
      sliceTokensBySequence(
        tokens,
        groupByClause.body_start_seq,
        groupByClause.body_end_seq
      )
    );

  const groupExpressions =
    splitTopLevelByComma(groupByTokens, 0);

  const dependencies = [];

  for (const expressionTokens of groupExpressions) {
    dependencies.push(
      ...buildDependenciesFromExpression(
        expressionTokens,
        sources,
        "GROUP_KEY",
        null,
        tokensToText(expressionTokens)
      )
    );
  }

  return dependencies;
}

/*
 * 関数: detectJoinStart
 * 目的:
 *   指定位置がJOIN句の開始か判定します。
 *   parseJoinDependenciesで、ON条件の終了位置を探すために利用します。
 */
function detectJoinStart(tokens, startIndex) {
  const first = normalizedTokenAt(tokens, startIndex);
  const second = normalizedTokenAt(tokens, startIndex + 1);
  const third = normalizedTokenAt(tokens, startIndex + 2);

  if (first === "JOIN") return { join_length: 1 };

  if (
    (first === "LEFT" || first === "RIGHT" || first === "FULL") &&
    second === "JOIN"
  ) {
    return { join_length: 2 };
  }

  if (
    (first === "LEFT" || first === "RIGHT" || first === "FULL") &&
    second === "OUTER" &&
    third === "JOIN"
  ) {
    return { join_length: 3 };
  }

  if (
    (first === "INNER" || first === "CROSS") &&
    second === "JOIN"
  ) {
    return { join_length: 2 };
  }

  return null;
}

/*
 * 関数: isTopLevelJoinStart
 * 目的:
 *   トップレベルのJOIN開始か確認します。
 *   サブクエリ内部のJOINは除外します。
 */
function isTopLevelJoinStart(tokens, tokenIndex) {
  const currentToken = tokens[tokenIndex];

  if (
    !currentToken ||
    currentToken.paren_depth !== 0
  ) {
    return false;
  }

  return detectJoinStart(tokens, tokenIndex) !== null;
}

/*
 * 関数: parseJoinDependencies
 * 目的:
 *   JOIN ... ON 条件で参照されるカラムを抽出します。
 *
 * ON条件の範囲:
 *   ONの次Tokenから、次のトップレベルJOIN直前までです。
 */
function parseJoinDependencies(tokens, fromClause, sources) {
  if (!fromClause) return [];

  const fromTokens =
    removeCommentTokens(
      sliceTokensBySequence(
        tokens,
        fromClause.body_start_seq,
        fromClause.body_end_seq
      )
    );

  const dependencies = [];

  for (
    let tokenIndex = 0;
    tokenIndex < fromTokens.length;
    tokenIndex++
  ) {
    const currentToken = fromTokens[tokenIndex];

    const isOnKeyword =
      currentToken.normalized_token === "ON" &&
      currentToken.paren_depth === 0;

    if (!isOnKeyword) continue;

    const expressionStartIndex = tokenIndex + 1;
    let expressionEndIndex = fromTokens.length;

    for (
      let searchIndex = expressionStartIndex;
      searchIndex < fromTokens.length;
      searchIndex++
    ) {
      if (isTopLevelJoinStart(fromTokens, searchIndex)) {
        expressionEndIndex = searchIndex;
        break;
      }
    }

    const expressionTokens =
      fromTokens.slice(
        expressionStartIndex,
        expressionEndIndex
      );

    dependencies.push(
      ...buildDependenciesFromExpression(
        expressionTokens,
        sources,
        "JOIN",
        null,
        tokensToText(expressionTokens)
      )
    );

    tokenIndex = expressionEndIndex - 1;
  }

  return dependencies;
}

/*
 * 関数: parseUsingDependencies
 * 目的:
 *   JOIN ... USING(column1, column2) のカラム依存を抽出します。
 *
 * USING列は複数Sourceに存在するため、この段階では特定Sourceへ確定せず、
 * メタデータ解決が必要な状態として残します。
 */
function parseUsingDependencies(tokens, fromClause) {
  if (!fromClause) return [];

  const fromTokens =
    removeCommentTokens(
      sliceTokensBySequence(
        tokens,
        fromClause.body_start_seq,
        fromClause.body_end_seq
      )
    );

  const dependencies = [];

  for (
    let tokenIndex = 0;
    tokenIndex < fromTokens.length;
    tokenIndex++
  ) {
    const currentToken = fromTokens[tokenIndex];

    if (
      currentToken.normalized_token !== "USING" ||
      currentToken.paren_depth !== 0
    ) {
      continue;
    }

    const openParen = fromTokens[tokenIndex + 1];

    if (!openParen || openParen.token !== "(") {
      continue;
    }

    const closeIndex =
      findMatchingCloseParenthesis(
        fromTokens,
        tokenIndex + 1
      );

    if (closeIndex < 0) continue;

    const usingTokens =
      fromTokens.slice(tokenIndex + 2, closeIndex);

    const usingColumns =
      splitTopLevelByComma(
        usingTokens,
        openParen.paren_depth + 1
      );

    for (const columnTokens of usingColumns) {
      for (const columnToken of columnTokens) {
        if (!isIdentifierToken(columnToken)) continue;

        dependencies.push({
          output_column: null,
          expression: tokensToText(columnTokens),
          usage_type: "JOIN_USING",
          source_alias: null,
          source_name: null,
          source_type: null,
          source_column: columnToken.normalized_token,
          start_token_seq: columnToken.token_seq,
          end_token_seq: columnToken.token_seq,
          resolution_status: "UNRESOLVED",
          resolution_reason:
            "USING_COLUMN_REQUIRES_SOURCE_METADATA"
        });
      }
    }

    tokenIndex = closeIndex;
  }

  return dependencies;
}


/* ============================================================
 * Window parser
 * ============================================================ */

/*
 * 関数: findWindowSectionPositions
 * 目的:
 *   OVER(...)内部のPARTITION BY、ORDER BY、Window Frame開始位置を探します。
 */
function findWindowSectionPositions(
  windowTokens,
  windowDepth
) {
  let partitionStartIndex = -1;
  let orderStartIndex = -1;
  let frameStartIndex = -1;

  for (
    let tokenIndex = 0;
    tokenIndex < windowTokens.length;
    tokenIndex++
  ) {
    const currentToken = windowTokens[tokenIndex];
    const nextToken = windowTokens[tokenIndex + 1];

    if (currentToken.paren_depth !== windowDepth) {
      continue;
    }

    if (
      currentToken.normalized_token === "PARTITION" &&
      nextToken &&
      nextToken.normalized_token === "BY" &&
      nextToken.paren_depth === windowDepth
    ) {
      partitionStartIndex = tokenIndex + 2;
      tokenIndex++;
      continue;
    }

    if (
      currentToken.normalized_token === "ORDER" &&
      nextToken &&
      nextToken.normalized_token === "BY" &&
      nextToken.paren_depth === windowDepth
    ) {
      orderStartIndex = tokenIndex + 2;
      tokenIndex++;
      continue;
    }

    if (
      frameStartIndex < 0 &&
      (
        currentToken.normalized_token === "ROWS" ||
        currentToken.normalized_token === "RANGE" ||
        currentToken.normalized_token === "GROUPS"
      )
    ) {
      frameStartIndex = tokenIndex;
    }
  }

  return {
    partition_start_index: partitionStartIndex,
    order_start_index: orderStartIndex,
    frame_start_index: frameStartIndex
  };
}

/*
 * 関数: extractPartitionTokens
 * 目的:
 *   OVER(...)からPARTITION BY式だけを切り出します。
 */
function extractPartitionTokens(windowTokens, positions) {
  if (positions.partition_start_index < 0) return [];

  let endIndex = windowTokens.length;

  if (positions.order_start_index >= 0) {
    endIndex = positions.order_start_index - 2;
  } else if (positions.frame_start_index >= 0) {
    endIndex = positions.frame_start_index;
  }

  return windowTokens.slice(
    positions.partition_start_index,
    endIndex
  );
}

/*
 * 関数: extractOrderTokens
 * 目的:
 *   OVER(...)からORDER BY式だけを切り出します。
 */
function extractOrderTokens(windowTokens, positions) {
  if (positions.order_start_index < 0) return [];

  let endIndex = windowTokens.length;

  if (positions.frame_start_index >= 0) {
    endIndex = positions.frame_start_index;
  }

  return windowTokens.slice(
    positions.order_start_index,
    endIndex
  );
}

/*
 * 関数: removeOrderModifiers
 * 目的:
 *   ASC/DESC/NULLS FIRST/LASTを除外し、カラム依存抽出のノイズを減らします。
 */
function removeOrderModifiers(tokens) {
  return tokens.filter(
    (token) =>
      token.normalized_token !== "ASC" &&
      token.normalized_token !== "DESC" &&
      token.normalized_token !== "NULLS" &&
      token.normalized_token !== "FIRST" &&
      token.normalized_token !== "LAST"
  );
}

/*
 * 関数: parseOverExpression
 * 目的:
 *   1つのOVER(...)を解析し、WINDOW_PARTITIONとWINDOW_ORDER依存へ分けます。
 */
function parseOverExpression(
  expressionTokens,
  overTokenIndex,
  sources,
  outputColumn
) {
  const openParenthesisIndex = overTokenIndex + 1;
  const openParenthesis =
    expressionTokens[openParenthesisIndex];

  if (
    !openParenthesis ||
    openParenthesis.token !== "("
  ) {
    return {
      dependencies: [],
      next_index: overTokenIndex
    };
  }

  const closeParenthesisIndex =
    findMatchingCloseParenthesis(
      expressionTokens,
      openParenthesisIndex
    );

  if (closeParenthesisIndex < 0) {
    return {
      dependencies: [],
      next_index: overTokenIndex
    };
  }

  const windowDepth =
    openParenthesis.paren_depth + 1;

  const windowTokens =
    expressionTokens.slice(
      openParenthesisIndex + 1,
      closeParenthesisIndex
    );

  const positions =
    findWindowSectionPositions(
      windowTokens,
      windowDepth
    );

  const partitionTokens =
    extractPartitionTokens(windowTokens, positions);

  const orderTokens =
    extractOrderTokens(windowTokens, positions);

  const dependencies = [];

  if (partitionTokens.length > 0) {
    const partitionExpressions =
      splitTopLevelByComma(
        partitionTokens,
        windowDepth
      );

    for (const expression of partitionExpressions) {
      dependencies.push(
        ...buildDependenciesFromExpression(
          expression,
          sources,
          "WINDOW_PARTITION",
          outputColumn,
          tokensToText(expression)
        )
      );
    }
  }

  if (orderTokens.length > 0) {
    const orderExpressions =
      splitTopLevelByComma(
        orderTokens,
        windowDepth
      );

    for (const expression of orderExpressions) {
      const cleanedTokens =
        removeOrderModifiers(expression);

      dependencies.push(
        ...buildDependenciesFromExpression(
          cleanedTokens,
          sources,
          "WINDOW_ORDER",
          outputColumn,
          tokensToText(cleanedTokens)
        )
      );
    }
  }

  return {
    dependencies: dependencies,
    next_index: closeParenthesisIndex
  };
}

/*
 * 関数: parseWindowExpressions
 * 目的:
 *   式の中に存在するすべてのOVER(...)を順番に解析します。
 */
function parseWindowExpressions(
  expressionTokens,
  sources,
  outputColumn
) {
  const dependencies = [];

  for (
    let tokenIndex = 0;
    tokenIndex < expressionTokens.length;
    tokenIndex++
  ) {
    const currentToken = expressionTokens[tokenIndex];

    if (currentToken.normalized_token !== "OVER") {
      continue;
    }

    const parsedWindow =
      parseOverExpression(
        expressionTokens,
        tokenIndex,
        sources,
        outputColumn
      );

    dependencies.push(...parsedWindow.dependencies);
    tokenIndex = parsedWindow.next_index;
  }

  return dependencies;
}


/* ============================================================
 * QUALIFY parser
 * ============================================================ */

/*
 * 関数: removeWindowSpecifications
 * 目的:
 *   QUALIFY式からOVER(...)部分だけを除外します。
 *
 * 理由:
 *   Window内部はWINDOW_PARTITION/WINDOW_ORDERとして別処理するため、
 *   QUALIFY依存として二重計上しないようにします。
 */
function removeWindowSpecifications(tokens) {
  const result = [];

  for (
    let tokenIndex = 0;
    tokenIndex < tokens.length;
    tokenIndex++
  ) {
    const currentToken = tokens[tokenIndex];

    if (currentToken.normalized_token !== "OVER") {
      result.push(currentToken);
      continue;
    }

    const nextToken = tokens[tokenIndex + 1];

    if (nextToken && nextToken.token !== "(") {
      tokenIndex++;
      continue;
    }

    if (!nextToken || nextToken.token !== "(") {
      continue;
    }

    const closeParenthesisIndex =
      findMatchingCloseParenthesis(
        tokens,
        tokenIndex + 1
      );

    if (closeParenthesisIndex < 0) continue;

    tokenIndex = closeParenthesisIndex;
  }

  return result;
}

/*
 * 関数: removeEmptyFunctionCalls
 * 目的:
 *   OVER(...)除去後に残るROW_NUMBER()のような空関数呼び出しを除外します。
 */
function removeEmptyFunctionCalls(tokens) {
  const result = [];

  for (
    let tokenIndex = 0;
    tokenIndex < tokens.length;
    tokenIndex++
  ) {
    const currentToken = tokens[tokenIndex];
    const openParenthesis = tokens[tokenIndex + 1];
    const closeParenthesis = tokens[tokenIndex + 2];

    const isEmptyFunctionCall =
      (
        currentToken.token_type === "IDENTIFIER" ||
        currentToken.token_type === "KEYWORD"
      ) &&
      openParenthesis &&
      openParenthesis.token === "(" &&
      closeParenthesis &&
      closeParenthesis.token === ")" &&
      closeParenthesis.paren_depth ===
        openParenthesis.paren_depth + 1;

    if (isEmptyFunctionCall) {
      tokenIndex += 2;
      continue;
    }

    result.push(currentToken);
  }

  return result;
}



/* ============================================================
 * Recursive Query / Scope / CTE integration
 * ============================================================ */

/*
 * 関数: nextNonCommentTokenIndex
 * 目的:
 *   指定位置以降で最初の非COMMENT Tokenのindexを返します。
 */
function nextNonCommentTokenIndex(tokens, startIndex) {
  for (
    let tokenIndex = startIndex;
    tokenIndex < tokens.length;
    tokenIndex++
  ) {
    if (tokens[tokenIndex].token_type !== "COMMENT") {
      return tokenIndex;
    }
  }

  return -1;
}


/*
 * 関数: findScalarSubqueries
 * 目的:
 *   SELECT式内の (SELECT ...) または (WITH ... SELECT ...) を検出します。
 *
 * 内側Queryは後で再帰的にparseQueryRecursiveへ渡します。
 */
function findScalarSubqueries(expressionTokens) {
  const subqueries = [];

  for (
    let tokenIndex = 0;
    tokenIndex < expressionTokens.length;
    tokenIndex++
  ) {
    const currentToken = expressionTokens[tokenIndex];

    if (currentToken.token !== "(") {
      continue;
    }

    const selectIndex =
      nextNonCommentTokenIndex(
        expressionTokens,
        tokenIndex + 1
      );

    if (selectIndex < 0) {
      continue;
    }

    if (
      expressionTokens[selectIndex].normalized_token !== "SELECT" &&
      expressionTokens[selectIndex].normalized_token !== "WITH"
    ) {
      continue;
    }

    const closeIndex =
      findMatchingCloseParenthesis(
        expressionTokens,
        tokenIndex
      );

    if (closeIndex < 0) {
      continue;
    }

    subqueries.push({
      open_index: tokenIndex,
      query_start_index: selectIndex,
      close_index: closeIndex,
      inner_tokens:
        expressionTokens.slice(
          selectIndex,
          closeIndex
        )
    });

    tokenIndex = closeIndex;
  }

  return subqueries;
}


/*
 * 関数: normalizeQueryTokenDepth
 * 目的:
 *   サブクエリやCTE内部のToken深度を、そのQueryのトップレベルが0になるよう補正します。
 *
 * 例:
 *   外側から見たSELECT depth=2
 *   ↓
 *   内側Queryとして解析するとSELECT depth=0
 */
function normalizeQueryTokenDepth(tokens) {
  if (tokens.length === 0) {
    return [];
  }

  const firstToken = tokens.find(
    (token) => token.token_type !== "COMMENT"
  );

  if (!firstToken) {
    return tokens.slice();
  }

  const baseDepth = firstToken.paren_depth;

  return tokens.map(
    (token) => ({
      ...token,
      paren_depth:
        token.paren_depth - baseDepth
    })
  );
}


/*
 * 関数: parseWithClause
 * 目的:
 *   WITH句を複数CTEへ分解し、最後のメインQueryも切り出します。
 *
 * 対応:
 *   WITH a AS (...), b AS (...) SELECT ...
 *   WITH RECURSIVE ...
 *   WITH cte_name(col1, col2) AS (...)
 *
 * 戻り値:
 *   recursive
 *   ctes[]
 *   main_query_tokens
 */
function parseWithClause(tokens) {
  const effectiveTokens =
    removeCommentTokens(
      normalizeQueryTokenDepth(tokens)
    );

  if (
    effectiveTokens.length === 0 ||
    effectiveTokens[0].normalized_token !== "WITH"
  ) {
    return {
      recursive: false,
      ctes: [],
      main_query_tokens: effectiveTokens
    };
  }

  let tokenIndex = 1;
  let recursive = false;

  if (
    effectiveTokens[tokenIndex] &&
    effectiveTokens[tokenIndex].normalized_token === "RECURSIVE"
  ) {
    recursive = true;
    tokenIndex++;
  }

  const ctes = [];

  while (tokenIndex < effectiveTokens.length) {
    const cteNameToken = effectiveTokens[tokenIndex];

    if (!isIdentifierToken(cteNameToken)) {
      break;
    }

    const cteName = cteNameToken.normalized_token;
    tokenIndex++;

    const cteColumns = [];

    if (
      effectiveTokens[tokenIndex] &&
      effectiveTokens[tokenIndex].token === "("
    ) {
      const columnCloseIndex =
        findMatchingCloseParenthesis(
          effectiveTokens,
          tokenIndex
        );

      if (columnCloseIndex < 0) {
        break;
      }

      for (
        let columnIndex = tokenIndex + 1;
        columnIndex < columnCloseIndex;
        columnIndex++
      ) {
        const columnToken = effectiveTokens[columnIndex];

        if (isIdentifierToken(columnToken)) {
          cteColumns.push(columnToken.normalized_token);
        }
      }

      tokenIndex = columnCloseIndex + 1;
    }

    if (
      !effectiveTokens[tokenIndex] ||
      effectiveTokens[tokenIndex].normalized_token !== "AS"
    ) {
      break;
    }

    tokenIndex++;

    if (
      !effectiveTokens[tokenIndex] ||
      effectiveTokens[tokenIndex].token !== "("
    ) {
      break;
    }

    const queryOpenIndex = tokenIndex;
    const queryCloseIndex =
      findMatchingCloseParenthesis(
        effectiveTokens,
        queryOpenIndex
      );

    if (queryCloseIndex < 0) {
      break;
    }

    ctes.push({
      cte_name: cteName,
      cte_columns: cteColumns,
      recursive: recursive,
      query_tokens:
        normalizeQueryTokenDepth(
          effectiveTokens.slice(
            queryOpenIndex + 1,
            queryCloseIndex
          )
        )
    });

    tokenIndex = queryCloseIndex + 1;

    if (
      effectiveTokens[tokenIndex] &&
      effectiveTokens[tokenIndex].token === ","
    ) {
      tokenIndex++;
      continue;
    }

    break;
  }

  return {
    recursive: recursive,
    ctes: ctes,
    main_query_tokens:
      normalizeQueryTokenDepth(
        effectiveTokens.slice(tokenIndex)
      )
  };
}


/*
 * 関数: buildCteSourceMap
 * 目的:
 *   CTE名からCTE定義情報を取得できるMapを作ります。
 *
 * parentQueryNameを含めることで、CTEをQuery Scopeごとに識別します。
 */
function buildCteSourceMap(ctes, parentQueryName) {
  const sourceMap = new Map();

  for (const cte of ctes) {
    sourceMap.set(
      cte.cte_name,
      {
        source_type: "CTE",
        source_name: cte.cte_name,
        recursive: cte.recursive,
        cte_columns: cte.cte_columns,
        cte_query_name:
          parentQueryName +
          "/CTE:" +
          cte.cte_name
      }
    );
  }

  return sourceMap;
}


/*
 * 関数: resolveCteSources
 * 目的:
 *   parseFromでOBJECTとして取得したSource名がCTE名なら、source_typeをCTEへ変更します。
 */
function resolveCteSources(sources, cteSourceMap) {
  return sources.map(
    (source) => {
      if (!source.source_name) {
        return source;
      }

      const sourceName =
        source.source_name.toUpperCase();

      if (!cteSourceMap.has(sourceName)) {
        return source;
      }

      const cteDefinition =
        cteSourceMap.get(sourceName);

      return {
        ...source,
        source_type: "CTE",
        recursive: cteDefinition.recursive,
        cte_columns: cteDefinition.cte_columns,
        cte_query_name: cteDefinition.cte_query_name
      };
    }
  );
}


/*
 * 関数: buildAliasMap
 * 目的:
 *   Scope解決用に、aliasまたはSource短縮名からSourceを取得できるMapを作ります。
 */
function buildAliasMap(sources) {
  const aliasMap = new Map();

  for (const source of sources) {
    if (source.source_alias) {
      aliasMap.set(
        source.source_alias.toUpperCase(),
        source
      );
    }

    if (source.source_name) {
      const parts = source.source_name.split(".");
      const shortName = parts[parts.length - 1];

      if (shortName) {
        aliasMap.set(
          shortName.toUpperCase(),
          source
        );
      }
    }
  }

  return aliasMap;
}


/*
 * 関数: resolveDependencyScope
 * 目的:
 *   カラム参照が現在QueryのSourceか、外側QueryのSourceかを判定します。
 *
 * 結果:
 *   LOCAL       : 現在Scope
 *   OUTER       : 外側Scope。相関サブクエリ参照
 *   UNRESOLVED  : どのScopeにもaliasが見つからない
 *
 * scope_distance:
 *   直上の外側Queryなら1、そのさらに外側なら2です。
 */
function resolveDependencyScope(
  dependency,
  localSources,
  outerScopes
) {
  if (!dependency.source_alias) {
    return {
      ...dependency,
      reference_scope: "LOCAL",
      scope_distance: 0
    };
  }

  const alias =
    dependency.source_alias.toUpperCase();

  const localMap =
    buildAliasMap(localSources);

  if (localMap.has(alias)) {
    const source = localMap.get(alias);

    return {
      ...dependency,
      source_name: source.source_name,
      source_type: source.source_type,
      source_cte_query_name:
        source.cte_query_name || null,
      resolution_status: "RESOLVED_SOURCE",
      resolution_reason: null,
      reference_scope: "LOCAL",
      scope_distance: 0
    };
  }

  for (
    let outerIndex = 0;
    outerIndex < outerScopes.length;
    outerIndex++
  ) {
    const outerMap =
      buildAliasMap(
        outerScopes[outerIndex]
      );

    if (!outerMap.has(alias)) {
      continue;
    }

    const source = outerMap.get(alias);

    return {
      ...dependency,
      source_name: source.source_name,
      source_type: source.source_type,
      source_cte_query_name:
        source.cte_query_name || null,
      resolution_status: "RESOLVED_OUTER_SCOPE",
      resolution_reason: null,
      reference_scope: "OUTER",
      scope_distance: outerIndex + 1
    };
  }

  return {
    ...dependency,
    reference_scope: "UNRESOLVED",
    scope_distance: null
  };
}


/*
 * 関数: decorateDependency
 * 目的:
 *   依存情報にquery_name、cte_name、scope_level、Scope解決結果を付加します。
 */
function decorateDependency(
  dependency,
  context
) {
  const scoped =
    resolveDependencyScope(
      dependency,
      context.local_sources,
      context.outer_scopes
    );

  return {
    ...scoped,
    query_name: context.query_name,
    scope_level: context.scope_level,
    cte_name: context.cte_name || null
  };
}


/*
 * 関数: removeScalarSubqueryTokens
 * 目的:
 *   外側SELECT式を解析するとき、内側スカラーサブクエリのToken範囲を除外します。
 *
 * 理由:
 *   内側Queryは再帰解析するため、外側式で二重にカラムを拾わないようにします。
 */
function removeScalarSubqueryTokens(
  expressionTokens,
  scalarSubqueries
) {
  const excludedSeqs = new Set();

  for (const subquery of scalarSubqueries) {
    for (
      let tokenIndex = subquery.open_index;
      tokenIndex <= subquery.close_index;
      tokenIndex++
    ) {
      excludedSeqs.add(
        expressionTokens[tokenIndex].token_seq
      );
    }
  }

  return expressionTokens.filter(
    (token) =>
      !excludedSeqs.has(token.token_seq)
  );
}


/*
 * 関数: collectCurrentQueryDependencies
 * 目的:
 *   現在の1Queryについて、SELECT/JOIN/WHERE/GROUP BY/HAVING/
 *   QUALIFY/Windowの直接依存をすべて集約します。
 *
 * この段階ではCTE参照を最終物理カラムへは展開しません。
 * まず「直接参照」を正確に記録し、後段で物理展開します。
 */
function collectCurrentQueryDependencies(
  queryTokens,
  clauses,
  selectItems,
  sources,
  context
) {
  const dependencies = [];

  /*
   * SELECT projection.
   * Scalar subquery内部は再帰処理へ回すため除外する。
   */
  for (const selectItem of selectItems) {
    const scalarSubqueries =
      findScalarSubqueries(
        selectItem.expression_tokens
      );

    const outerExpressionTokens =
      removeScalarSubqueryTokens(
        selectItem.expression_tokens,
        scalarSubqueries
      );

    const projectionDependencies =
      buildDependenciesFromExpression(
        outerExpressionTokens,
        sources,
        "PROJECTION",
        selectItem.output_alias,
        selectItem.expression
      );

    for (const dependency of projectionDependencies) {
      dependencies.push(
        decorateDependency(
          dependency,
          context
        )
      );
    }
  }

  const fromClause =
    clauses.find(
      (clause) => clause.clause === "FROM"
    );

  const whereClause =
    clauses.find(
      (clause) => clause.clause === "WHERE"
    );

  const groupByClause =
    clauses.find(
      (clause) => clause.clause === "GROUP_BY"
    );

  const havingClause =
    clauses.find(
      (clause) => clause.clause === "HAVING"
    );

  const qualifyClause =
    clauses.find(
      (clause) => clause.clause === "QUALIFY"
    );

  const clauseDependencies = [];

  clauseDependencies.push(
    ...parseJoinDependencies(
      queryTokens,
      fromClause,
      sources
    )
  );

  clauseDependencies.push(
    ...parseUsingDependencies(
      queryTokens,
      fromClause
    )
  );

  clauseDependencies.push(
    ...parseSingleExpressionClause(
      queryTokens,
      whereClause,
      sources,
      "FILTER"
    )
  );

  clauseDependencies.push(
    ...parseGroupByDependencies(
      queryTokens,
      groupByClause,
      sources
    )
  );

  clauseDependencies.push(
    ...parseSingleExpressionClause(
      queryTokens,
      havingClause,
      sources,
      "HAVING"
    )
  );

  for (const dependency of clauseDependencies) {
    dependencies.push(
      decorateDependency(
        dependency,
        context
      )
    );
  }

  /*
   * SELECTとQUALIFY内のWindow。
   */
  for (const selectItem of selectItems) {
    const windowDependencies =
      parseWindowExpressions(
        selectItem.expression_tokens,
        sources,
        selectItem.output_alias
      );

    for (const dependency of windowDependencies) {
      dependencies.push(
        decorateDependency(
          dependency,
          context
        )
      );
    }
  }

  if (qualifyClause) {
    const qualifyTokens =
      removeCommentTokens(
        sliceTokensBySequence(
          queryTokens,
          qualifyClause.body_start_seq,
          qualifyClause.body_end_seq
        )
      );

    const qualifyWindowDependencies =
      parseWindowExpressions(
        qualifyTokens,
        sources,
        null
      );

    for (const dependency of qualifyWindowDependencies) {
      dependencies.push(
        decorateDependency(
          dependency,
          context
        )
      );
    }

    let ordinaryQualifyTokens =
      removeWindowSpecifications(
        qualifyTokens
      );

    ordinaryQualifyTokens =
      removeEmptyFunctionCalls(
        ordinaryQualifyTokens
      );

    const qualifyDependencies =
      buildDependenciesFromExpression(
        ordinaryQualifyTokens,
        sources,
        "QUALIFY",
        null,
        tokensToText(
          ordinaryQualifyTokens
        )
      );

    for (const dependency of qualifyDependencies) {
      dependencies.push(
        decorateDependency(
          dependency,
          context
        )
      );
    }
  }

  return dependencies;
}



/*
 * 関数: isSetOperatorAt
 * 目的:
 *   指定位置がUNION / UNION ALL / EXCEPT / INTERSECTかを判定します。
 */
function isSetOperatorAt(tokens, tokenIndex) {
  const currentToken = tokens[tokenIndex];

  if (
    !currentToken ||
    currentToken.paren_depth !== 0
  ) {
    return false;
  }

  const keyword = currentToken.normalized_token;

  if (
    keyword === "UNION" ||
    keyword === "INTERSECT"
  ) {
    return true;
  }

  if (keyword !== "EXCEPT") {
    return false;
  }

  /*
   * SELECT * EXCEPT(...) と集合演算EXCEPTを区別する。
   * 集合演算なら後方にSELECT / WITHが続く。
   */
  let nextIndex = tokenIndex + 1;

  while (
    tokens[nextIndex] &&
    (
      tokens[nextIndex].normalized_token === "ALL" ||
      tokens[nextIndex].normalized_token === "DISTINCT"
    )
  ) {
    nextIndex++;
  }

  return Boolean(
    tokens[nextIndex] &&
    (
      tokens[nextIndex].normalized_token === "SELECT" ||
      tokens[nextIndex].normalized_token === "WITH"
    )
  );
}


/*
 * 関数: splitTopLevelSetQueries
 * 目的:
 *   トップレベルの集合演算子でQueryを複数Branchへ分割します。
 *
 * 例:
 *   SELECT ... UNION ALL SELECT ...
 *   ↓
 *   branch 1
 *   branch 2
 */
function splitTopLevelSetQueries(tokens) {
  const branches = [];
  let branchStartIndex = 0;

  for (
    let tokenIndex = 0;
    tokenIndex < tokens.length;
    tokenIndex++
  ) {
    if (!isSetOperatorAt(tokens, tokenIndex)) {
      continue;
    }

    const branchTokens =
      tokens.slice(
        branchStartIndex,
        tokenIndex
      );

    if (branchTokens.length > 0) {
      branches.push(
        normalizeQueryTokenDepth(
          branchTokens
        )
      );
    }

    tokenIndex++;

    if (
      tokens[tokenIndex] &&
      (
        tokens[tokenIndex].normalized_token === "ALL" ||
        tokens[tokenIndex].normalized_token === "DISTINCT"
      )
    ) {
      tokenIndex++;
    }

    branchStartIndex = tokenIndex;
    tokenIndex--;
  }

  const lastBranch =
    tokens.slice(branchStartIndex);

  if (lastBranch.length > 0) {
    branches.push(
      normalizeQueryTokenDepth(
        lastBranch
      )
    );
  }

  return branches;
}


/*
 * 関数: parseQueryRecursive
 * 目的:
 *   Query解析の中心となる再帰関数です。
 *
 * 主な責務:
 *   1. WITH句を解析
 *   2. CTE定義を再帰解析
 *   3. UNION等をBranchへ分割
 *   4. SELECT/FROMを解析
 *   5. 現Queryの直接依存を収集
 *   6. SELECT内スカラーサブクエリを再帰解析
 *
 * optionsにはQuery Scope、親CTE Map、Query名などを渡します。
 */
function parseQueryRecursive(options) {
  const parsedWith =
    parseWithClause(
      options.query_tokens
    );

  const cteSourceMap =
    buildCteSourceMap(
      parsedWith.ctes,
      options.query_name
    );

  const dependencies = [];

  /*
   * CTE定義を解析する。
   * 全CTE名を先にMapへ登録するため、再帰CTEの自己参照もCTE扱いになる。
   */
  for (const cte of parsedWith.ctes) {
    dependencies.push(
      ...parseQueryRecursive({
        query_tokens:
          cte.query_tokens,
        outer_scopes:
          options.outer_scopes,
        scope_level:
          options.scope_level + 1,
        query_name:
          cteSourceMap
            .get(cte.cte_name)
            .cte_query_name,
        cte_name:
          cte.cte_name,
        inherited_cte_map:
          cteSourceMap
      })
    );
  }

  const mainTokens =
    parsedWith.main_query_tokens;

  const clauses =
    parseClauses(mainTokens);

  const selectClause =
    clauses.find(
      (clause) =>
        clause.clause === "SELECT"
    );

  const fromClause =
    clauses.find(
      (clause) =>
        clause.clause === "FROM"
    );

  const selectItems =
    selectClause
      ? parseSelect(
          mainTokens,
          selectClause
        )
      : [];

  const rawSources =
    fromClause
      ? parseFrom(
          mainTokens,
          fromClause
        )
      : [];

  /*
   * 現Queryで定義されたCTEに加え、親Queryから継承したCTEも解決対象にする。
   */
  const combinedCteMap =
    new Map();

  if (options.inherited_cte_map) {
    for (
      const entry
      of options.inherited_cte_map.entries()
    ) {
      combinedCteMap.set(
        entry[0],
        entry[1]
      );
    }
  }

  for (
    const entry
    of cteSourceMap.entries()
  ) {
    combinedCteMap.set(
      entry[0],
      entry[1]
    );
  }


  const setQueryBranches =
    splitTopLevelSetQueries(
      mainTokens
    );

  if (setQueryBranches.length > 1) {
    for (
      const branchTokens
      of setQueryBranches
    ) {
      dependencies.push(
        ...parseQueryRecursive({
          query_tokens:
            branchTokens,
          outer_scopes:
            options.outer_scopes,
          scope_level:
            options.scope_level,
          query_name:
            options.query_name,
          cte_name:
            options.cte_name || null,
          inherited_cte_map:
            combinedCteMap
        })
      );
    }

    return dependencies;
  }

  const sources =
    resolveCteSources(
      rawSources,
      combinedCteMap
    );

  const context = {
    query_name:
      options.query_name,
    cte_name:
      options.cte_name || null,
    scope_level:
      options.scope_level,
    local_sources:
      sources,
    outer_scopes:
      options.outer_scopes
  };

  dependencies.push(
    ...collectCurrentQueryDependencies(
      mainTokens,
      clauses,
      selectItems,
      sources,
      context
    )
  );

  /*
   * SELECT式内のScalar Subqueryを再帰解析する。
   */
  for (const selectItem of selectItems) {
    const scalarSubqueries =
      findScalarSubqueries(
        selectItem.expression_tokens
      );

    let subqueryNumber = 0;

    for (const subquery of scalarSubqueries) {
      subqueryNumber++;

      const childDependencies =
        parseQueryRecursive({
          query_tokens:
            subquery.inner_tokens,
          outer_scopes: [
            sources,
            ...options.outer_scopes
          ],
          scope_level:
            options.scope_level + 1,
          query_name:
            options.query_name +
            "/SCALAR_" +
            subqueryNumber,
          cte_name:
            options.cte_name || null,
          inherited_cte_map:
            combinedCteMap
        });

      for (const childDependency of childDependencies) {
        let usageType =
          childDependency.usage_type;

        if (
          childDependency.reference_scope === "OUTER"
        ) {
          if (
            childDependency.usage_type === "FILTER"
          ) {
            usageType = "CORRELATED_FILTER";
          } else {
            usageType = "CORRELATED_REFERENCE";
          }
        } else {
          usageType =
            "SCALAR_SUBQUERY_" +
            childDependency.usage_type;
        }

        dependencies.push({
          ...childDependency,
          output_column:
            selectItem.output_alias,
          usage_type:
            usageType
        });
      }
    }
  }

  return dependencies;
}



/* ============================================================
 * CTE output-column -> final physical-column resolver
 * ============================================================ */

/*
 * 関数: buildCteOutputDependencyMap
 * 目的:
 *   CTEの各出力列が、内部でどのSourceカラムへ依存するかをMapへまとめます。
 *
 * Keyの概念:
 *   CTEのQuery名 + 出力列名
 *
 * このMapを利用し、別QueryからCTE列が参照された際に内部依存へ置換します。
 */
function buildCteOutputDependencyMap(dependencies) {
  const outputMap = new Map();

  for (const dependency of dependencies) {
    if (
      !dependency.query_name ||
      dependency.query_name.indexOf("/CTE:") < 0 ||
      !dependency.output_column
    ) {
      continue;
    }

    const key =
      dependency.query_name +
      "|" +
      dependency.output_column.toUpperCase();

    if (!outputMap.has(key)) {
      outputMap.set(key, []);
    }

    outputMap.get(key).push(dependency);
  }

  return outputMap;
}


/*
 * 関数: appendLineagePath
 * 目的:
 *   リネージ経路の各要素を" > "で連結し、表示用文字列へ変換します。
 */
function appendLineagePath(pathParts) {
  return pathParts
    .filter((part) => part !== null && part !== "")
    .join(" > ");
}


/*
 * 関数: expandDependencyToPhysical
 * 目的:
 *   1件の依存を、CTEをたどりながら最終物理テーブル・物理カラムまで再帰展開します。
 *
 * 引数:
 *   dependency       : 現在展開中の依存
 *   rootDependency   : 最初の依存。出力列やusage_typeを維持するために使う
 *   cteOutputMap     : CTE出力列 → 内部依存のMap
 *   visitingKeys     : 現在の再帰経路で訪問中のKey集合
 *   pathParts        : lineage_pathを構築するための経路配列
 *
 * 循環検知:
 *   visitingKeysに同じCTE出力Keyが既にあれば再帰CTE循環と判定し、
 *   無限再帰せずRECURSIVE_CYCLEとして返します。
 */
function expandDependencyToPhysical(
  rootDependency,
  currentDependency,
  cteOutputMap,
  expansionStack,
  pathParts
) {
  if (currentDependency.source_type !== "CTE") {
    return [{
      ...rootDependency,
      immediate_source_name:
        rootDependency.source_name,
      immediate_source_type:
        rootDependency.source_type,
      immediate_source_column:
        rootDependency.source_column,
      source_name:
        currentDependency.source_name,
      source_type:
        currentDependency.source_type,
      source_column:
        currentDependency.source_column,
      lineage_path:
        appendLineagePath([
          ...pathParts,
          currentDependency.source_name &&
          currentDependency.source_column
            ? currentDependency.source_name +
              "." +
              currentDependency.source_column
            : currentDependency.source_name
        ]),
      expansion_status: "PHYSICAL_RESOLVED"
    }];
  }

  const cteQueryName =
    currentDependency.source_cte_query_name;

  if (!cteQueryName) {
    return [{
      ...rootDependency,
      immediate_source_name:
        rootDependency.source_name,
      immediate_source_type:
        rootDependency.source_type,
      immediate_source_column:
        rootDependency.source_column,
      source_name: null,
      source_type: null,
      source_column: null,
      lineage_path:
        appendLineagePath(pathParts),
      expansion_status:
        "CTE_DEFINITION_NOT_IDENTIFIED",
      resolution_status: "UNRESOLVED",
      resolution_reason:
        "CTE_QUERY_NAME_NOT_FOUND"
    }];
  }

  const outputColumn =
    currentDependency.source_column;

  const lookupKey =
    cteQueryName +
    "|" +
    (outputColumn || "").toUpperCase();

  if (expansionStack.has(lookupKey)) {
    return [{
      ...rootDependency,
      immediate_source_name:
        rootDependency.source_name,
      immediate_source_type:
        rootDependency.source_type,
      immediate_source_column:
        rootDependency.source_column,
      source_name:
        currentDependency.source_name,
      source_type: "CTE",
      source_column:
        currentDependency.source_column,
      lineage_path:
        appendLineagePath([
          ...pathParts,
          currentDependency.source_name +
          "." +
          currentDependency.source_column
        ]),
      expansion_status: "RECURSIVE_CYCLE",
      resolution_status: "PARTIAL",
      resolution_reason:
        "RECURSIVE_CTE_CYCLE_DETECTED"
    }];
  }

  const candidateDependencies =
    cteOutputMap.get(lookupKey) || [];

  if (candidateDependencies.length === 0) {
    return [{
      ...rootDependency,
      immediate_source_name:
        rootDependency.source_name,
      immediate_source_type:
        rootDependency.source_type,
      immediate_source_column:
        rootDependency.source_column,
      source_name: null,
      source_type: null,
      source_column: null,
      lineage_path:
        appendLineagePath([
          ...pathParts,
          currentDependency.source_name +
          "." +
          currentDependency.source_column
        ]),
      expansion_status:
        "CTE_OUTPUT_COLUMN_NOT_FOUND",
      resolution_status: "UNRESOLVED",
      resolution_reason:
        "CTE_OUTPUT_DEPENDENCY_NOT_FOUND"
    }];
  }

  const nextStack =
    new Set(expansionStack);

  nextStack.add(lookupKey);

  const nextPath = [
    ...pathParts,
    currentDependency.source_name +
    "." +
    currentDependency.source_column
  ];

  const expanded = [];

  for (const candidate of candidateDependencies) {
    expanded.push(
      ...expandDependencyToPhysical(
        rootDependency,
        candidate,
        cteOutputMap,
        nextStack,
        nextPath
      )
    );
  }

  return expanded;
}


/*
 * 関数: resolveAllDependenciesToPhysical
 * 目的:
 *   直接依存一覧からCTE出力Mapを構築し、すべての依存を物理カラムまで展開します。
 *
 * ここがParser結果を最終リネージ結果へ変換するResolverの入口です。
 */
function resolveAllDependenciesToPhysical(dependencies) {
  const cteOutputMap =
    buildCteOutputDependencyMap(
      dependencies
    );

  const expanded = [];

  for (const dependency of dependencies) {
    /*
     * CTE定義自身の行も保持するが、最終結果では物理展開する。
     * 物理Sourceはそのまま1行となる。
     */
    const initialPath = [
      dependency.query_name,
      dependency.output_column
        ? dependency.output_column
        : dependency.usage_type
    ];

    expanded.push(
      ...expandDependencyToPhysical(
        dependency,
        dependency,
        cteOutputMap,
        new Set(),
        initialPath
      )
    );
  }

  return expanded;
}


/*
 * ============================================================================
 * UDFエントリーポイント
 *
 * ここから上は関数定義です。
 * BigQueryがUDFを呼び出した際、ここから実際の処理が開始されます。
 *
 * 実行順:
 *   1. NULL入力なら空配列を返す
 *   2. tokenizeでSQL全文をToken化
 *   3. parseQueryRecursiveでCTE・サブクエリを含む直接依存を抽出
 *   4. resolveAllDependenciesToPhysicalでCTEを物理カラムまで展開
 *   5. BigQueryのRETURNS STRUCT定義に合わせて項目を整形
 * ============================================================================
 */
if (sql_text === null) {
  return [];
}

const rootTokens =
  tokenize(sql_text);

const recursiveDependencies =
  parseQueryRecursive({
    query_tokens: rootTokens,
    outer_scopes: [],
    scope_level: 0,
    query_name: "MAIN",
    cte_name: null,
    inherited_cte_map: new Map()
  });

const physicalDependencies =
  resolveAllDependenciesToPhysical(
    recursiveDependencies
  );

/*
 * JavaScript側の内部オブジェクトから、
 * BigQueryのRETURNS ARRAY<STRUCT<...>>と同じ項目順のオブジェクトへ変換します。
 *
 * mapは各dependencyを1件ずつ変換し、新しい配列を返します。
 */
return physicalDependencies.map(
  (dependency, index) => ({
    dependency_seq: index + 1,
    query_name:
      dependency.query_name,
    cte_name:
      dependency.cte_name,
    scope_level:
      dependency.scope_level,
    reference_scope:
      dependency.reference_scope,
    scope_distance:
      dependency.scope_distance,
    output_column:
      dependency.output_column,
    expression:
      dependency.expression,
    usage_type:
      dependency.usage_type,
    source_alias:
      dependency.source_alias,
    immediate_source_name:
      dependency.immediate_source_name,
    immediate_source_type:
      dependency.immediate_source_type,
    immediate_source_column:
      dependency.immediate_source_column,
    source_name:
      dependency.source_name,
    source_type:
      dependency.source_type,
    source_column:
      dependency.source_column,
    lineage_path:
      dependency.lineage_path,
    expansion_status:
      dependency.expansion_status,
    start_token_seq:
      dependency.start_token_seq,
    end_token_seq:
      dependency.end_token_seq,
    resolution_status:
      dependency.resolution_status,
    resolution_reason:
      dependency.resolution_reason
  })
);
""";


-- ============================================================
-- Sample: CTE + nested WITH + scalar subquery + correlated ref
-- ============================================================

SELECT *
FROM UNNEST(
  parse_dependencies_physical("""
WITH base_customer AS (
  SELECT
    customer_id,
    is_active
  FROM `project.dataset.customer`
  WHERE is_active = TRUE
),

customer_sales AS (
  WITH completed_sales AS (
    SELECT
      customer_id,
      amount,
      sales_date
    FROM `project.dataset.sales`
    WHERE status = 'COMPLETE'
  )

  SELECT
    c.customer_id,
    SUM(s.amount) AS total_amount
  FROM base_customer AS c
  LEFT JOIN completed_sales AS s
    ON c.customer_id = s.customer_id
  GROUP BY
    c.customer_id
)

SELECT
  cs.customer_id,
  cs.total_amount,

  (
    SELECT
      MAX(o.order_date)
    FROM `project.dataset.orders` AS o
    WHERE
      o.customer_id = cs.customer_id
      AND o.status = 'COMPLETE'
  ) AS last_order_date

FROM customer_sales AS cs

QUALIFY
  ROW_NUMBER() OVER (
    PARTITION BY cs.customer_id
    ORDER BY cs.total_amount DESC
  ) = 1
  """)
)
ORDER BY
  dependency_seq;


-- ============================================================
-- INFORMATION_SCHEMA.VIEWS example
-- ============================================================

/*
SELECT
  views.table_catalog,
  views.table_schema,
  views.table_name,
  dependency.*
FROM
  `your_project.your_dataset.INFORMATION_SCHEMA.VIEWS` AS views
CROSS JOIN
  UNNEST(
    parse_dependencies_physical(
      views.view_definition
    )
  ) AS dependency
ORDER BY
  views.table_catalog,
  views.table_schema,
  views.table_name,
  dependency.dependency_seq;
*/
