-- BDE BigQuery UDF integrated prototype
-- CTE output columns recursively expanded to final physical columns

CREATE TEMP FUNCTION parse_dependencies_with_columns(
  sql_text STRING,
  column_metadata ARRAY<STRUCT<
    table_catalog STRING,
    table_schema STRING,
    table_name STRING,
    column_name STRING,
    ordinal_position INT64
  >>
)
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
  output_ordinal_position INT64,
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

  function advanceCharacter(character) {
    if (character === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    index++;
  }

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

function normalizedTokenAt(tokens, index) {
  const token = tokens[index];
  return token ? (token.normalized_token || "") : "";
}

function sliceTokensBySequence(tokens, startSequence, endSequence) {
  return tokens.filter(
    (token) =>
      token.token_seq >= startSequence &&
      token.token_seq <= endSequence
  );
}

function removeCommentTokens(tokens) {
  return tokens.filter(
    (token) => token.token_type !== "COMMENT"
  );
}

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

function isIdentifierToken(token) {
  if (!token) return false;

  return (
    token.token_type === "IDENTIFIER" ||
    token.token_type === "BACKTICK_IDENTIFIER"
  );
}

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
 * SELECT STAR parser
 * ============================================================ */

function parseStarSelectItem(selectItem) {
  const tokens = selectItem.expression_tokens;

  if (!tokens || tokens.length === 0) {
    return null;
  }

  let tokenIndex = 0;
  let sourceAlias = null;

  if (tokens[0].token === "*") {
    tokenIndex = 1;
  } else if (
    tokens.length >= 3 &&
    isIdentifierToken(tokens[0]) &&
    tokens[1].token === "." &&
    tokens[2].token === "*"
  ) {
    sourceAlias = tokens[0].normalized_token;
    tokenIndex = 3;
  } else {
    return null;
  }

  const excludedColumns = new Set();
  const replacements = [];

  while (tokenIndex < tokens.length) {
    const currentToken = tokens[tokenIndex];

    if (
      currentToken.normalized_token === "EXCEPT" &&
      tokens[tokenIndex + 1] &&
      tokens[tokenIndex + 1].token === "("
    ) {
      const closeIndex = findMatchingCloseParenthesis(tokens, tokenIndex + 1);

      if (closeIndex < 0) {
        break;
      }

      for (
        let columnIndex = tokenIndex + 2;
        columnIndex < closeIndex;
        columnIndex++
      ) {
        const columnToken = tokens[columnIndex];

        if (isIdentifierToken(columnToken)) {
          excludedColumns.add(columnToken.normalized_token);
        }
      }

      tokenIndex = closeIndex + 1;
      continue;
    }

    if (
      currentToken.normalized_token === "REPLACE" &&
      tokens[tokenIndex + 1] &&
      tokens[tokenIndex + 1].token === "("
    ) {
      const openIndex = tokenIndex + 1;
      const closeIndex = findMatchingCloseParenthesis(tokens, openIndex);

      if (closeIndex < 0) {
        break;
      }

      const replacementTokens = tokens.slice(openIndex + 1, closeIndex);
      const replacementItems = splitTopLevelByComma(
        replacementTokens,
        tokens[openIndex].paren_depth + 1
      );

      for (const itemTokens of replacementItems) {
        const replacementDepth =
          tokens[openIndex].paren_depth + 1;

        let asIndex = -1;

        for (
          let replacementIndex = itemTokens.length - 2;
          replacementIndex >= 0;
          replacementIndex--
        ) {
          if (
            itemTokens[replacementIndex].normalized_token === "AS" &&
            itemTokens[replacementIndex].paren_depth === replacementDepth
          ) {
            asIndex = replacementIndex;
            break;
          }
        }

        if (
          asIndex < 0 ||
          !isIdentifierToken(itemTokens[asIndex + 1])
        ) {
          continue;
        }

        const aliasToken = itemTokens[asIndex + 1];
        const expressionTokens = itemTokens.slice(0, asIndex);
        const outputAlias = aliasToken.normalized_token;

        excludedColumns.add(outputAlias.toUpperCase());

        replacements.push({
          output_alias: outputAlias,
          expression: tokensToText(expressionTokens),
          expression_tokens: expressionTokens,
          start_token_seq: itemTokens[0].token_seq,
          end_token_seq: itemTokens[itemTokens.length - 1].token_seq
        });
      }

      tokenIndex = closeIndex + 1;
      continue;
    }

    tokenIndex++;
  }

  return {
    source_alias: sourceAlias,
    excluded_columns: Array.from(excludedColumns),
    replacements: replacements
  };
}


function findStarTargetSources(sources, sourceAlias) {
  if (!sourceAlias) {
    return sources.filter(
      (source) => source.source_type !== "UNNEST"
    );
  }

  const normalizedAlias = sourceAlias.toUpperCase();

  return sources.filter(
    (source) => {
      if (
        source.source_alias &&
        source.source_alias.toUpperCase() === normalizedAlias
      ) {
        return true;
      }

      if (!source.source_name) {
        return false;
      }

      const parts = source.source_name.split(".");
      const shortName = parts[parts.length - 1];

      return Boolean(
        shortName &&
        shortName.toUpperCase() === normalizedAlias
      );
    }
  );
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

function isFunctionName(tokens, tokenIndex) {
  const currentToken = tokens[tokenIndex];
  const nextToken = tokens[tokenIndex + 1];

  return (
    isIdentifierToken(currentToken) &&
    nextToken &&
    nextToken.token === "("
  );
}

function isAliasDefinition(tokens, tokenIndex) {
  const previousToken = tokens[tokenIndex - 1];

  return (
    previousToken &&
    previousToken.normalized_token === "AS"
  );
}

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
    const starSpec = parseStarSelectItem(selectItem);

    if (starSpec) {
      const targetSources = findStarTargetSources(
        sources,
        starSpec.source_alias
      );

      if (targetSources.length === 0) {
        dependencies.push(
          decorateDependency(
            {
              output_column: "*",
              expression: selectItem.expression,
              usage_type: "PROJECTION_STAR",
              source_alias: starSpec.source_alias,
              source_name: null,
              source_type: null,
              source_cte_query_name: null,
              source_column: "*",
              star_excluded_columns: starSpec.excluded_columns,
              start_token_seq: selectItem.start_token_seq,
              end_token_seq: selectItem.end_token_seq,
              resolution_status: "UNRESOLVED",
              resolution_reason: "STAR_SOURCE_NOT_FOUND"
            },
            context
          )
        );
      }

      for (const source of targetSources) {
        dependencies.push(
          decorateDependency(
            {
              output_column: "*",
              expression: selectItem.expression,
              usage_type: "PROJECTION_STAR",
              source_alias: source.source_alias,
              source_name: source.source_name,
              source_type: source.source_type,
              source_cte_query_name: source.cte_query_name || null,
              source_column: "*",
              star_excluded_columns: starSpec.excluded_columns,
              start_token_seq: selectItem.start_token_seq,
              end_token_seq: selectItem.end_token_seq,
              resolution_status: "RESOLVED_SOURCE",
              resolution_reason: null
            },
            context
          )
        );
      }

      for (const replacement of starSpec.replacements) {
        const replacementDependencies =
          buildDependenciesFromExpression(
            replacement.expression_tokens,
            sources,
            "PROJECTION_REPLACE",
            replacement.output_alias,
            replacement.expression
          );

        for (const dependency of replacementDependencies) {
          dependencies.push(
            decorateDependency(
              dependency,
              context
            )
          );
        }
      }

      continue;
    }

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
 * INFORMATION_SCHEMA.COLUMNS metadata resolver
 * ============================================================ */

function normalizeObjectName(value) {
  return (value || "")
    .replace(/^`|`$/g, "")
    .toUpperCase();
}


function buildColumnMetadataMap(metadataRows) {
  const metadataMap = new Map();

  for (const row of (metadataRows || [])) {
    if (!row || !row.table_name || !row.column_name) {
      continue;
    }

    const catalog = normalizeObjectName(row.table_catalog);
    const schema = normalizeObjectName(row.table_schema);
    const table = normalizeObjectName(row.table_name);

    const keys = [table];

    if (schema) {
      keys.push(schema + "." + table);
    }

    if (catalog && schema) {
      keys.push(catalog + "." + schema + "." + table);
    }

    const column = {
      column_name: row.column_name.toUpperCase(),
      ordinal_position: row.ordinal_position
    };

    for (const key of keys) {
      if (!metadataMap.has(key)) {
        metadataMap.set(key, []);
      }

      metadataMap.get(key).push(column);
    }
  }

  for (const columns of metadataMap.values()) {
    columns.sort(
      (left, right) =>
        (left.ordinal_position || 0) -
        (right.ordinal_position || 0)
    );
  }

  return metadataMap;
}


function findMetadataColumns(sourceName, metadataMap) {
  const normalized = normalizeObjectName(sourceName);

  if (metadataMap.has(normalized)) {
    return metadataMap.get(normalized);
  }

  const parts = normalized.split(".");

  if (parts.length >= 2) {
    const schemaTable = parts.slice(-2).join(".");

    if (metadataMap.has(schemaTable)) {
      return metadataMap.get(schemaTable);
    }
  }

  const shortName = parts[parts.length - 1];
  return metadataMap.get(shortName) || [];
}


function isExcludedStarColumn(columnName, dependency) {
  const exclusions = dependency.star_excluded_columns || [];
  return exclusions.indexOf(columnName.toUpperCase()) >= 0;
}


/* ============================================================
 * CTE output-column -> final physical-column resolver
 * ============================================================ */

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


function appendLineagePath(pathParts) {
  return pathParts
    .filter((part) => part !== null && part !== "")
    .join(" > ");
}


function expandDependencyToPhysical(
  rootDependency,
  currentDependency,
  cteOutputMap,
  columnMetadataMap,
  expansionStack,
  pathParts
) {
  if (
    currentDependency.source_type !== "CTE" &&
    currentDependency.source_column === "*"
  ) {
    const metadataColumns = findMetadataColumns(
      currentDependency.source_name,
      columnMetadataMap
    );

    if (metadataColumns.length === 0) {
      return [{
        ...rootDependency,
        immediate_source_name: rootDependency.source_name,
        immediate_source_type: rootDependency.source_type,
        immediate_source_column: "*",
        source_name: currentDependency.source_name,
        source_type: currentDependency.source_type,
        source_column: "*",
        lineage_path: appendLineagePath([
          ...pathParts,
          currentDependency.source_name + ".*"
        ]),
        expansion_status: "STAR_METADATA_NOT_FOUND",
        output_ordinal_position: null,
        resolution_status: "UNRESOLVED",
        resolution_reason: "COLUMN_METADATA_NOT_FOUND"
      }];
    }

    return metadataColumns
      .filter(
        (column) =>
          !isExcludedStarColumn(
            column.column_name,
            rootDependency
          )
      )
      .map(
        (column) => ({
          ...rootDependency,
          output_column: column.column_name,
          immediate_source_name: rootDependency.source_name,
          immediate_source_type: rootDependency.source_type,
          immediate_source_column: column.column_name,
          source_name: currentDependency.source_name,
          source_type: currentDependency.source_type,
          source_column: column.column_name,
          lineage_path: appendLineagePath([
            ...pathParts,
            currentDependency.source_name + "." + column.column_name
          ]),
          expansion_status: "STAR_METADATA_RESOLVED",
          output_ordinal_position: column.ordinal_position,
          resolution_status: "RESOLVED_SOURCE",
          resolution_reason: null
        })
      );
  }

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
      expansion_status: "PHYSICAL_RESOLVED",
      output_ordinal_position:
        rootDependency.output_ordinal_position || null
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

  if (outputColumn === "*") {
    const prefix = cteQueryName + "|";
    const candidateKeys = [];

    for (const key of cteOutputMap.keys()) {
      if (key.indexOf(prefix) === 0) {
        const columnName = key.substring(prefix.length);

        if (
          columnName &&
          !isExcludedStarColumn(
            columnName,
            rootDependency
          )
        ) {
          candidateKeys.push(key);
        }
      }
    }

    if (candidateKeys.length === 0) {
      return [{
        ...rootDependency,
        immediate_source_name: rootDependency.source_name,
        immediate_source_type: rootDependency.source_type,
        immediate_source_column: "*",
        source_name: null,
        source_type: null,
        source_column: null,
        lineage_path: appendLineagePath([
          ...pathParts,
          currentDependency.source_name + ".*"
        ]),
        expansion_status: "CTE_STAR_COLUMNS_NOT_FOUND",
        output_ordinal_position: null,
        resolution_status: "UNRESOLVED",
        resolution_reason: "CTE_OUTPUT_COLUMNS_NOT_FOUND"
      }];
    }

    const expandedStars = [];
    let ordinalPosition = 0;

    for (const candidateKey of candidateKeys) {
      ordinalPosition++;
      const columnName = candidateKey.substring(prefix.length);
      const candidates = cteOutputMap.get(candidateKey) || [];

      for (const candidate of candidates) {
        expandedStars.push(
          ...expandDependencyToPhysical(
            {
              ...rootDependency,
              output_column: columnName,
              output_ordinal_position: ordinalPosition
            },
            candidate,
            cteOutputMap,
            columnMetadataMap,
            new Set(expansionStack),
            [
              ...pathParts,
              currentDependency.source_name + "." + columnName
            ]
          )
        );
      }
    }

    return expandedStars;
  }

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
        columnMetadataMap,
        nextStack,
        nextPath
      )
    );
  }

  return expanded;
}


function resolveAllDependenciesToPhysical(dependencies, columnMetadataMap) {
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
        columnMetadataMap,
        new Set(),
        initialPath
      )
    );
  }

  return expanded;
}


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

const columnMetadataMap =
  buildColumnMetadataMap(
    column_metadata || []
  );

const physicalDependencies =
  resolveAllDependenciesToPhysical(
    recursiveDependencies,
    columnMetadataMap
  );

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
    output_ordinal_position:
      dependency.output_ordinal_position || null,
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
-- Sample 1: build column metadata and expand *, EXCEPT, REPLACE
-- Replace project/dataset names before execution.
-- ============================================================

WITH column_metadata AS (
  SELECT ARRAY_AGG(
    STRUCT(
      table_catalog,
      table_schema,
      table_name,
      column_name,
      ordinal_position
    )
    ORDER BY
      table_catalog,
      table_schema,
      table_name,
      ordinal_position
  ) AS columns
  FROM your_project.`region-your_region`.INFORMATION_SCHEMA.COLUMNS
  WHERE table_schema IN (
    'source_dataset',
    'view_dataset'
  )
)
SELECT dependency.*
FROM column_metadata
CROSS JOIN UNNEST(
  parse_dependencies_with_columns(
    """
WITH base AS (
  SELECT
    * EXCEPT(deleted_flag)
    REPLACE(
      UPPER(customer_name) AS customer_name
    )
  FROM `your_project.source_dataset.customer`
),
summary AS (
  SELECT
    base.*,
    sales.total_amount
  FROM base
  LEFT JOIN `your_project.source_dataset.sales_summary` AS sales
    ON base.customer_id = sales.customer_id
)
SELECT
  * EXCEPT(internal_note)
FROM summary
    """,
    column_metadata.columns
  )
) AS dependency
ORDER BY
  dependency.dependency_seq;


-- ============================================================
-- Sample 2: apply to INFORMATION_SCHEMA.VIEWS
-- Regional INFORMATION_SCHEMA is used so metadata can cover
-- multiple datasets in one array.
-- ============================================================

/*
WITH column_metadata AS (
  SELECT ARRAY_AGG(
    STRUCT(
      table_catalog,
      table_schema,
      table_name,
      column_name,
      ordinal_position
    )
    ORDER BY
      table_catalog,
      table_schema,
      table_name,
      ordinal_position
  ) AS columns
  FROM your_project.`region-your_region`.INFORMATION_SCHEMA.COLUMNS
),
views AS (
  SELECT
    table_catalog,
    table_schema,
    table_name,
    view_definition
  FROM your_project.`region-your_region`.INFORMATION_SCHEMA.VIEWS
  WHERE table_schema = 'view_dataset'
)
SELECT
  views.table_catalog,
  views.table_schema,
  views.table_name,
  dependency.*
FROM views
CROSS JOIN column_metadata
CROSS JOIN UNNEST(
  parse_dependencies_with_columns(
    views.view_definition,
    column_metadata.columns
  )
) AS dependency
ORDER BY
  views.table_catalog,
  views.table_schema,
  views.table_name,
  dependency.dependency_seq;
*/
