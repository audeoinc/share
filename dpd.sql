CREATE TEMP FUNCTION parse_clauses(sql STRING)
RETURNS ARRAY<
  STRUCT<
    clause_seq INT64,
    clause STRING,
    clause_start_seq INT64,
    body_start_seq INT64,
    body_end_seq INT64,
    paren_depth INT64
  >
>
LANGUAGE js
AS r"""
function tokenize(sqlText) {
  const tokens = [];

  let tokenSeq = 0;
  let line = 1;
  let column = 1;
  let parenDepth = 0;
  let index = 0;

  const KEYWORDS = new Set([
    "SELECT",
    "FROM",
    "WHERE",
    "GROUP",
    "BY",
    "HAVING",
    "QUALIFY",
    "ORDER",
    "LIMIT",
    "JOIN",
    "LEFT",
    "RIGHT",
    "FULL",
    "INNER",
    "OUTER",
    "CROSS",
    "ON",
    "WITH",
    "RECURSIVE",
    "AS",
    "UNION",
    "ALL",
    "DISTINCT",
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "NULL",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "OVER",
    "PARTITION",
    "UNNEST",
    "STRUCT",
    "ARRAY",
    "EXCEPT",
    "REPLACE",
    "INTERSECT",
    "OFFSET",
    "ORDINAL"
  ]);

  const SYMBOLS = new Set([
    "(",
    ")",
    ",",
    ".",
    ";",
    "[",
    "]"
  ]);

  const SINGLE_OPERATORS = new Set([
    "=",
    "+",
    "-",
    "*",
    "/",
    "%",
    "<",
    ">",
    "!"
  ]);

  const DOUBLE_OPERATORS = new Set([
    ">=",
    "<=",
    "!=",
    "<>",
    "||"
  ]);

  function pushToken(
    token,
    normalizedToken,
    tokenType,
    tokenLine,
    tokenColumn
  ) {
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

  function isSpace(ch) {
    return /\s/.test(ch);
  }

  function isIdentifierStart(ch) {
    return /[A-Za-z_]/.test(ch);
  }

  function isIdentifierPart(ch) {
    return /[A-Za-z0-9_]/.test(ch);
  }

  function isDigit(ch) {
    return /[0-9]/.test(ch);
  }

  function advanceChar(ch) {
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }

    index++;
  }

  while (index < sqlText.length) {
    const ch = sqlText[index];

    /*
     * 空白
     */
    if (isSpace(ch)) {
      advanceChar(ch);
      continue;
    }

    const startLine = line;
    const startColumn = column;

    /*
     * 1行コメント
     */
    if (
      ch === "-" &&
      sqlText[index + 1] === "-"
    ) {
      let value = "";

      while (
        index < sqlText.length &&
        sqlText[index] !== "\n"
      ) {
        value += sqlText[index];
        advanceChar(sqlText[index]);
      }

      pushToken(
        value,
        value,
        "COMMENT",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * ブロックコメント
     */
    if (
      ch === "/" &&
      sqlText[index + 1] === "*"
    ) {
      let value = "";

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;

        if (
          current === "*" &&
          sqlText[index + 1] === "/"
        ) {
          advanceChar(current);

          value += sqlText[index];
          advanceChar(sqlText[index]);

          break;
        }

        advanceChar(current);
      }

      pushToken(
        value,
        value,
        "COMMENT",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * バッククォート識別子
     */
    if (ch === "`") {
      let value = "";

      value += ch;
      advanceChar(ch);

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;
        advanceChar(current);

        if (current === "`") {
          break;
        }
      }

      const normalized =
        value.length >= 2
          ? value.substring(1, value.length - 1)
          : value;

      pushToken(
        value,
        normalized,
        "BACKTICK_IDENTIFIER",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * 文字列リテラル
     */
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = "";

      value += ch;
      advanceChar(ch);

      while (index < sqlText.length) {
        const current = sqlText[index];

        value += current;
        advanceChar(current);

        /*
         * '' や "" のエスケープ
         */
        if (
          current === quote &&
          sqlText[index] === quote
        ) {
          value += sqlText[index];
          advanceChar(sqlText[index]);
          continue;
        }

        if (current === quote) {
          break;
        }
      }

      const normalized =
        value.length >= 2
          ? value.substring(1, value.length - 1)
          : value;

      pushToken(
        value,
        normalized,
        "STRING",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * 識別子・予約語
     */
    if (isIdentifierStart(ch)) {
      let value = "";

      while (
        index < sqlText.length &&
        isIdentifierPart(sqlText[index])
      ) {
        value += sqlText[index];
        advanceChar(sqlText[index]);
      }

      const normalized = value.toUpperCase();

      const tokenType =
        KEYWORDS.has(normalized)
          ? "KEYWORD"
          : "IDENTIFIER";

      pushToken(
        value,
        normalized,
        tokenType,
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * 数値
     */
    if (isDigit(ch)) {
      let value = "";

      while (
        index < sqlText.length &&
        /[0-9.]/.test(sqlText[index])
      ) {
        value += sqlText[index];
        advanceChar(sqlText[index]);
      }

      pushToken(
        value,
        value,
        "NUMBER",
        startLine,
        startColumn
      );

      continue;
    }

    /*
     * 2文字演算子
     */
    const twoCharacters =
      sqlText.substring(index, index + 2);

    if (DOUBLE_OPERATORS.has(twoCharacters)) {
      pushToken(
        twoCharacters,
        twoCharacters,
        "OPERATOR",
        startLine,
        startColumn
      );

      advanceChar(sqlText[index]);
      advanceChar(sqlText[index]);

      continue;
    }

    /*
     * 記号
     */
    if (SYMBOLS.has(ch)) {
      pushToken(
        ch,
        ch,
        "SYMBOL",
        startLine,
        startColumn
      );

      if (ch === "(" || ch === "[") {
        parenDepth++;
      } else if (ch === ")" || ch === "]") {
        parenDepth--;
      }

      advanceChar(ch);
      continue;
    }

    /*
     * 1文字演算子
     */
    if (SINGLE_OPERATORS.has(ch)) {
      pushToken(
        ch,
        ch,
        "OPERATOR",
        startLine,
        startColumn
      );

      advanceChar(ch);
      continue;
    }

    /*
     * 未対応文字
     */
    pushToken(
      ch,
      ch,
      "UNKNOWN",
      startLine,
      startColumn
    );

    advanceChar(ch);
  }

  return tokens;
}


function normalizedToken(tokens, index) {
  const token = tokens[index];

  if (!token) {
    return "";
  }

  return token.normalized_token || "";
}


function detectClause(tokens, index) {
  const first = normalizedToken(tokens, index);
  const second = normalizedToken(tokens, index + 1);

  if (first === "SELECT") {
    return {
      clause: "SELECT",
      token_length: 1
    };
  }

  if (first === "FROM") {
    return {
      clause: "FROM",
      token_length: 1
    };
  }

  if (first === "WHERE") {
    return {
      clause: "WHERE",
      token_length: 1
    };
  }

  if (first === "HAVING") {
    return {
      clause: "HAVING",
      token_length: 1
    };
  }

  if (first === "QUALIFY") {
    return {
      clause: "QUALIFY",
      token_length: 1
    };
  }

  if (first === "LIMIT") {
    return {
      clause: "LIMIT",
      token_length: 1
    };
  }

  if (
    first === "GROUP" &&
    second === "BY"
  ) {
    return {
      clause: "GROUP_BY",
      token_length: 2
    };
  }

  if (
    first === "ORDER" &&
    second === "BY"
  ) {
    return {
      clause: "ORDER_BY",
      token_length: 2
    };
  }

  return null;
}


function parseClauses(tokens) {
  const clauses = [];

  /*
   * コメントはClause判定には使わない。
   */
  const effectiveTokens = tokens.filter(
    (token) => token.token_type !== "COMMENT"
  );

  for (
    let index = 0;
    index < effectiveTokens.length;
    index++
  ) {
    const currentToken = effectiveTokens[index];

    /*
     * スカラーサブクエリや関数内のClauseは
     * この段階では対象外。
     */
    if (currentToken.paren_depth !== 0) {
      continue;
    }

    const detected =
      detectClause(effectiveTokens, index);

    if (!detected) {
      continue;
    }

    clauses.push({
      clause_seq: clauses.length + 1,
      clause: detected.clause,
      clause_start_seq: currentToken.token_seq,
      body_start_seq:
        currentToken.token_seq +
        detected.token_length,
      body_end_seq: null,
      paren_depth: currentToken.paren_depth
    });
  }

  /*
   * 各Clauseの終了位置を設定する。
   */
  for (
    let index = 0;
    index < clauses.length;
    index++
  ) {
    const currentClause = clauses[index];
    const nextClause = clauses[index + 1];

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


if (sql === null) {
  return [];
}

const tokens = tokenize(sql);

return parseClauses(tokens);
""";