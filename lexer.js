function tokenize(sql) {
  const tokens = [];
  let seq = 0;
  let line = 1;
  let column = 1;
  let depth = 0;
  let i = 0;

  const KEYWORDS = new Set([
    "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "QUALIFY",
    "ORDER", "LIMIT", "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "OUTER",
    "CROSS", "ON", "WITH", "RECURSIVE", "AS", "UNION", "ALL", "DISTINCT",
    "AND", "OR", "NOT", "IN", "IS", "NULL", "CASE", "WHEN", "THEN",
    "ELSE", "END", "OVER", "PARTITION", "UNNEST", "STRUCT", "ARRAY",
    "EXCEPT", "REPLACE"
  ]);

  const SYMBOL = new Set(["(", ")", ",", ".", ";", "[", "]"]);
  const SINGLE_OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "<", ">", "!"]);
  const DOUBLE_OPERATORS = new Set([">=", "<=", "!=", "<>", "||"]);

  function pushToken(token, normalizedToken, tokenType, tokenLine, tokenColumn) {
    tokens.push({
      token_seq: ++seq,
      line_no: tokenLine,
      column_no: tokenColumn,
      token,
      normalized_token: normalizedToken,
      token_type: tokenType,
      paren_depth: depth,
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
    i++;
  }

  while (i < sql.length) {
    const ch = sql[i];

    if (isSpace(ch)) {
      advanceChar(ch);
      continue;
    }

    const startLine = line;
    const startColumn = column;

    if (ch === "-" && sql[i + 1] === "-") {
      let value = "";
      while (i < sql.length && sql[i] !== "\n") {
        value += sql[i];
        advanceChar(sql[i]);
      }
      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let value = "";
      while (i < sql.length) {
        value += sql[i];

        if (sql[i] === "*" && sql[i + 1] === "/") {
          advanceChar(sql[i]);
          value += sql[i];
          advanceChar(sql[i]);
          break;
        }

        advanceChar(sql[i]);
      }
      pushToken(value, value, "COMMENT", startLine, startColumn);
      continue;
    }

    if (ch === "`") {
      let value = "";
      value += ch;
      advanceChar(ch);

      while (i < sql.length) {
        const current = sql[i];
        value += current;
        advanceChar(current);
        if (current === "`") break;
      }

      const normalized = value.substring(1, value.length - 1);
      pushToken(value, normalized, "BACKTICK_IDENTIFIER", startLine, startColumn);
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = "";
      value += ch;
      advanceChar(ch);

      while (i < sql.length) {
        const current = sql[i];
        value += current;
        advanceChar(current);

        if (current === quote && sql[i] === quote) {
          value += sql[i];
          advanceChar(sql[i]);
          continue;
        }

        if (current === quote) break;
      }

      const normalized = value.substring(1, value.length - 1);
      pushToken(value, normalized, "STRING", startLine, startColumn);
      continue;
    }

    if (isIdentifierStart(ch)) {
      let value = "";

      while (i < sql.length && isIdentifierPart(sql[i])) {
        value += sql[i];
        advanceChar(sql[i]);
      }

      const normalized = value.toUpperCase();
      const tokenType = KEYWORDS.has(normalized) ? "KEYWORD" : "IDENTIFIER";

      pushToken(value, normalized, tokenType, startLine, startColumn);
      continue;
    }

    if (isDigit(ch)) {
      let value = "";

      while (i < sql.length && /[0-9.]/.test(sql[i])) {
        value += sql[i];
        advanceChar(sql[i]);
      }

      pushToken(value, value, "NUMBER", startLine, startColumn);
      continue;
    }

    const two = sql.substring(i, i + 2);

    if (DOUBLE_OPERATORS.has(two)) {
      pushToken(two, two, "OPERATOR", startLine, startColumn);
      advanceChar(sql[i]);
      advanceChar(sql[i]);
      continue;
    }

    if (SYMBOL.has(ch)) {
      pushToken(ch, ch, "SYMBOL", startLine, startColumn);

      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth--;

      advanceChar(ch);
      continue;
    }

    if (SINGLE_OPERATORS.has(ch)) {
      pushToken(ch, ch, "OPERATOR", startLine, startColumn);
      advanceChar(ch);
      continue;
    }

    pushToken(ch, ch, "UNKNOWN", startLine, startColumn);
    advanceChar(ch);
  }

  return tokens;
}

module.exports = tokenize;