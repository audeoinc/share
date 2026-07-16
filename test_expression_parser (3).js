"use strict";

const { TokenReader } = require("./token_reader");

/**
 * Clause Parserが抽出したSELECT句本文を、SELECT項目単位へ分解する。
 *
 * このParserの責務:
 *
 * 1. SELECT句本文だけをToken配列から取り出す。
 * 2. SELECT句と同じ階層にあるカンマで項目を分割する。
 * 3. 各項目から明示的・暗黙的な出力aliasを分離する。
 * 4. 単純カラムやWildcardの出力情報を整理する。
 * 5. 後続のExpression Parserが解析できるよう、式のtoken_seq範囲を返す。
 *
 * このParserが行わないこと:
 *
 * - 式の内部構造の解析
 * - カラムがどのテーブルに属するかの解決
 * - Wildcardの物理カラム展開
 *
 * これらは後続のExpression ParserやResolverの責務とする。
 */
class SelectParser {
  /**
   * @param {Array<object>} tokens Lexerが生成した全Token
   */
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("SelectParser: tokens must be an array.");
    }

    this.tokens = tokens;
    this.reader = new TokenReader(tokens);
  }

  /**
   * SELECT Clauseを解析し、SELECT項目一覧を返す。
   *
   * selectClauseにはClauseParserが返したSELECT Clauseを渡す。
   * body_start_seqとbody_end_seqがSELECT本文の範囲を表すため、
   * SelectParser自身がSQL全体からSELECTやFROMを探し直す必要はない。
   *
   * @param {object} selectClause ClauseParserが返したSELECT Clause
   * @returns {Array<object>}
   */
  parse(selectClause) {
    this.#validateSelectClause(selectClause);

    const selectTokens = this.reader.sliceByTokenSeq(
      selectClause.body_start_seq,
      selectClause.body_end_seq
    );

    const contentTokens = this.#removeSelectModifiers(selectTokens);
    const itemTokenGroups = this.#splitTopLevelByComma(
      contentTokens,
      selectClause.paren_depth
    );

    return itemTokenGroups.map((itemTokens, itemIndex) => {
      return this.#parseSelectItem(itemTokens, itemIndex + 1);
    });
  }

  /**
   * ClauseParserから渡された値がSELECT Clauseとして利用可能か確認する。
   *
   * 早い段階で明確な例外を出すことで、SelectParser内部の別処理で
   * null参照や不自然な空配列が発生し、原因が分かりにくくなるのを防ぐ。
   *
   * @param {object} selectClause
   */
  #validateSelectClause(selectClause) {
    if (!selectClause || typeof selectClause !== "object") {
      throw new TypeError("SelectParser.parse: selectClause must be an object.");
    }

    if (selectClause.clause_type !== "SELECT") {
      throw new TypeError(
        `SelectParser.parse: clause_type must be SELECT, but received ` +
        `${String(selectClause.clause_type)}.`
      );
    }

    if (
      !Number.isInteger(selectClause.body_start_seq) ||
      !Number.isInteger(selectClause.body_end_seq)
    ) {
      throw new TypeError(
        "SelectParser.parse: SELECT body token sequences must be integers."
      );
    }

    if (!Number.isInteger(selectClause.paren_depth)) {
      throw new TypeError(
        "SelectParser.parse: selectClause.paren_depth must be an integer."
      );
    }
  }

  /**
   * SELECT本文の先頭にあるSELECT修飾子を取り除く。
   *
   * 例えば次のDISTINCTはSELECT項目ではない。
   *
   *   SELECT DISTINCT customer_id, amount
   *          ^^^^^^^^
   *
   * これを残したままにすると、最初の項目が
   * "DISTINCT customer_id"という式として扱われてしまう。
   *
   * DISTINCT、ALL、AS STRUCT、AS VALUEを対象とする。
   * これらはSELECT項目そのものではなく、SELECT全体の出力形式を指定する。
   *
   * COMMENTは修飾子判定を妨げないが、元のToken列には残す。
   * そのため修飾子直前までのCOMMENTも合わせて除外する。
   *
   * @param {Array<object>} tokens SELECT本文Token
   * @returns {Array<object>}
   */
  #removeSelectModifiers(tokens) {
    let firstContentIndex = 0;

    while (
      firstContentIndex < tokens.length &&
      tokens[firstContentIndex].token_type === "COMMENT"
    ) {
      firstContentIndex++;
    }

    const firstContentToken = tokens[firstContentIndex];

    if (
      firstContentToken &&
      ["DISTINCT", "ALL"].includes(firstContentToken.normalized_token)
    ) {
      return tokens.slice(firstContentIndex + 1);
    }

    const secondContentIndex = this.#findNextNonCommentIndex(
      tokens,
      firstContentIndex + 1
    );

    const secondContentToken = secondContentIndex >= 0
      ? tokens[secondContentIndex]
      : null;

    if (
      firstContentToken?.normalized_token === "AS" &&
      ["STRUCT", "VALUE"].includes(secondContentToken?.normalized_token)
    ) {
      return tokens.slice(secondContentIndex + 1);
    }

    return tokens;
  }


  /**
   * 指定位置以降で最初の非COMMENT Tokenの配列indexを返す。
   *
   * SELECT AS STRUCT / AS VALUEでは、ASとSTRUCT/VALUEの間に
   * コメントが挟まる可能性があるため、単純なindex + 1ではなく
   * 次の実内容Tokenを探す必要がある。
   *
   * @param {Array<object>} tokens
   * @param {number} startIndex
   * @returns {number}
   */
  #findNextNonCommentIndex(tokens, startIndex) {
    for (let tokenIndex = startIndex; tokenIndex < tokens.length; tokenIndex++) {
      if (tokens[tokenIndex].token_type !== "COMMENT") {
        return tokenIndex;
      }
    }

    return -1;
  }

  /**
   * SELECT本文を、SELECT項目ごとのToken配列へ分割する。
   *
   * 単純にすべてのカンマで分割してはいけない。
   * 関数引数やSTRUCT内部にもカンマが存在するためである。
   *
   *   SELECT IF(a > 0, b, c), customer_id
   *                         ^ ここだけが項目区切り
   *
   * Clauseと同じparen_depthのカンマだけを項目区切りとして扱う。
   * 括弧内部のカンマはより深いparen_depthを持つため分割されない。
   *
   * @param {Array<object>} tokens SELECT本文Token
   * @param {number} itemDepth SELECT項目区切りが存在するdepth
   * @returns {Array<Array<object>>}
   */
  #splitTopLevelByComma(tokens, itemDepth) {
    const result = [];
    let currentItem = [];

    for (const token of tokens) {
      if (token.token === "," && token.paren_depth === itemDepth) {
        const trimmedItem = this.#removeCommentTokens(currentItem);

        if (trimmedItem.length === 0) {
          throw new SyntaxError(
            `SelectParser: empty SELECT item before token_seq ${token.token_seq}.`
          );
        }

        result.push(trimmedItem);
        currentItem = [];
        continue;
      }

      currentItem.push(token);
    }

    const lastItem = this.#removeCommentTokens(currentItem);

    if (lastItem.length > 0) {
      result.push(lastItem);
    } else if (result.length > 0) {
      throw new SyntaxError("SelectParser: SELECT list ends with a comma.");
    }

    if (result.length === 0) {
      throw new SyntaxError("SelectParser: SELECT clause contains no items.");
    }

    return result;
  }

  /**
   * 1つのSELECT項目を解析する。
   *
   * ここでは主に「式」と「出力alias」を分離する。
   * 式そのものをASTへ変換する処理はExpression Parserへ委譲する。
   *
   * @param {Array<object>} itemTokens 1項目分のToken
   * @param {number} selectItemSeq SELECT項目の連番
   * @returns {object}
   */
  #parseSelectItem(itemTokens, selectItemSeq) {
    const aliasResult = this.#parseAlias(itemTokens);
    const wildcardResult = this.#parseWildcard(aliasResult.expression_tokens);
    const expressionTokens = aliasResult.expression_tokens;

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `SelectParser: SELECT item ${selectItemSeq} has no expression.`
      );
    }

    return {
      select_item_seq: selectItemSeq,
      item_start_seq: itemTokens[0].token_seq,
      item_end_seq: itemTokens[itemTokens.length - 1].token_seq,
      expression_start_seq: expressionTokens[0].token_seq,
      expression_end_seq: expressionTokens[expressionTokens.length - 1].token_seq,
      expression: this.#tokensToText(expressionTokens),
      output_alias: aliasResult.output_alias,
      alias_type: aliasResult.alias_type,
      wildcard_type: wildcardResult.wildcard_type,
      wildcard_qualifier: wildcardResult.wildcard_qualifier
    };
  }

  /**
   * SELECT項目からaliasを判定し、式部分とalias部分を分離する。
   *
   * 判定順序には意味がある。
   *
   * 1. 明示的alias: expression AS alias
   * 2. 暗黙alias:   expression alias
   * 3. 単純カラムから出力名を導出
   * 4. aliasなし
   *
   * 明示的なASを最優先にすることで、式中の末尾Identifierを誤って
   * 暗黙aliasと解釈する可能性を減らす。
   *
   * @param {Array<object>} itemTokens
   * @returns {object}
   */
  #parseAlias(itemTokens) {
    const explicitAlias = this.#findExplicitAlias(itemTokens);

    if (explicitAlias) {
      return explicitAlias;
    }

    const implicitAlias = this.#findImplicitAlias(itemTokens);

    if (implicitAlias) {
      return implicitAlias;
    }

    const derivedAlias = this.#deriveColumnAlias(itemTokens);

    if (derivedAlias) {
      return derivedAlias;
    }

    return {
      expression_tokens: itemTokens,
      output_alias: null,
      alias_type: "NONE"
    };
  }

  /**
   * トップレベルのASを右側から探し、明示的aliasを抽出する。
   *
   * 右側から探す理由:
   * SELECT項目のaliasは通常末尾にあり、式内部のCAST(... AS TYPE)にある
   * ASを誤って出力aliasとして扱わないためである。
   * CAST内部のASは項目より深いparen_depthなので対象外となる。
   *
   * ASの後ろには非COMMENT Tokenが1つだけ存在することを要求する。
   * 余分なTokenがあれば曖昧なSQLを黙って受け入れずSyntaxErrorにする。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #findExplicitAlias(itemTokens) {
    const itemDepth = itemTokens[0].paren_depth;

    for (let tokenIndex = itemTokens.length - 1; tokenIndex >= 0; tokenIndex--) {
      const currentToken = itemTokens[tokenIndex];

      if (
        currentToken.normalized_token !== "AS" ||
        currentToken.paren_depth !== itemDepth
      ) {
        continue;
      }

      const aliasTokens = this.#removeCommentTokens(itemTokens.slice(tokenIndex + 1));

      if (aliasTokens.length !== 1 || !this.#isAliasToken(aliasTokens[0])) {
        throw new SyntaxError(
          `SelectParser: invalid explicit alias after token_seq ` +
          `${currentToken.token_seq}.`
        );
      }

      const expressionTokens = this.#removeCommentTokens(
        itemTokens.slice(0, tokenIndex)
      );

      return {
        expression_tokens: expressionTokens,
        output_alias: aliasTokens[0].normalized_token,
        alias_type: "EXPLICIT_AS"
      };
    }

    return null;
  }

  /**
   * ASを省略した暗黙aliasを判定する。
   *
   *   SUM(amount) total_amount
   *               ^^^^^^^^^^^^
   *
   * 最後のTokenがIdentifierであり、その直前のTokenが式の終端として
   * 自然な場合だけaliasとみなす。
   *
   * 例えば「a + b」のbをaliasと誤認しないよう、直前が演算子なら
   * 暗黙aliasとして扱わない。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #findImplicitAlias(itemTokens) {
    const significantTokens = itemTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length < 2) {
      return null;
    }

    const aliasToken = significantTokens[significantTokens.length - 1];
    const previousToken = significantTokens[significantTokens.length - 2];

    if (!this.#isAliasToken(aliasToken)) {
      return null;
    }

    if (!this.#canEndExpression(previousToken)) {
      return null;
    }

    const aliasIndex = itemTokens.indexOf(aliasToken);
    const expressionTokens = this.#removeCommentTokens(itemTokens.slice(0, aliasIndex));

    return {
      expression_tokens: expressionTokens,
      output_alias: aliasToken.normalized_token,
      alias_type: "IMPLICIT"
    };
  }

  /**
   * aliasが省略された単純カラム参照から、出力列名を導出する。
   *
   *   customer_id   -> CUSTOMER_ID
   *   c.customer_id -> CUSTOMER_ID
   *
   * 計算式や関数は出力名を安全に導出できないため対象外とする。
   *
   * @param {Array<object>} itemTokens
   * @returns {object|null}
   */
  #deriveColumnAlias(itemTokens) {
    const significantTokens = itemTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length === 1 && this.#isIdentifierToken(significantTokens[0])) {
      return {
        expression_tokens: itemTokens,
        output_alias: significantTokens[0].normalized_token,
        alias_type: "DERIVED_COLUMN"
      };
    }

    if (significantTokens.length >= 3) {
      const columnToken = significantTokens[significantTokens.length - 1];
      const dotToken = significantTokens[significantTokens.length - 2];

      if (dotToken.token === "." && this.#isIdentifierToken(columnToken)) {
        return {
          expression_tokens: itemTokens,
          output_alias: columnToken.normalized_token,
          alias_type: "DERIVED_COLUMN"
        };
      }
    }

    return null;
  }

  /**
   * Wildcard表現を分類する。
   *
   *   *       -> ALL
   *   sales.* -> QUALIFIED
   *
   * Wildcardの展開自体にはテーブルスキーマが必要なため、ここでは
   * 種別と修飾子だけを記録し、Physical Resolverへ引き渡す。
   *
   * @param {Array<object>} expressionTokens
   * @returns {object}
   */
  #parseWildcard(expressionTokens) {
    const significantTokens = expressionTokens.filter(
      (token) => token.token_type !== "COMMENT"
    );

    if (significantTokens.length === 1 && significantTokens[0].token === "*") {
      return {
        wildcard_type: "ALL",
        wildcard_qualifier: null
      };
    }

    if (significantTokens.length >= 3) {
      const wildcardToken = significantTokens[significantTokens.length - 1];
      const dotToken = significantTokens[significantTokens.length - 2];
      const qualifierToken = significantTokens[significantTokens.length - 3];

      if (
        wildcardToken.token === "*" &&
        dotToken.token === "." &&
        this.#isIdentifierToken(qualifierToken)
      ) {
        return {
          wildcard_type: "QUALIFIED",
          wildcard_qualifier: qualifierToken.normalized_token
        };
      }
    }

    return {
      wildcard_type: null,
      wildcard_qualifier: null
    };
  }

  /**
   * Tokenがalias名として利用可能な識別子か判定する。
   *
   * 通常識別子とバッククォート識別子を許可する。
   * Keywordを無条件に許可するとSQL構造との区別が曖昧になるため、
   * Keywordをaliasにする場合はバッククォートで囲むことを前提とする。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #isAliasToken(token) {
    return this.#isIdentifierToken(token);
  }

  /**
   * Tokenが通常またはバッククォート識別子か判定する。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #isIdentifierToken(token) {
    return ["IDENTIFIER", "BACKTICK_IDENTIFIER"].includes(token.token_type);
  }

  /**
   * 指定Tokenの直後に暗黙aliasを置けるか判定する。
   *
   * 式の末尾として自然なものだけを許可する。
   * これにより「a + b」のbをaliasと誤認することを防ぐ。
   *
   * @param {object} token
   * @returns {boolean}
   */
  #canEndExpression(token) {
    if (["IDENTIFIER", "BACKTICK_IDENTIFIER", "NUMBER", "STRING"].includes(token.token_type)) {
      return true;
    }

    if (token.token === ")" || token.token === "]") {
      return true;
    }

    if (["END", "NULL", "TRUE", "FALSE"].includes(token.normalized_token)) {
      return true;
    }

    return false;
  }

  /**
   * Token配列の先頭と末尾にあるCOMMENT Tokenを除外する。
   *
   * 項目内部のCOMMENTは式の位置情報や再構成に必要なため残す。
   * 先頭・末尾COMMENTだけを除外することで、expression_start_seqと
   * expression_end_seqが実際の式を指すようにする。
   *
   * @param {Array<object>} tokens
   * @returns {Array<object>}
   */
  #removeCommentTokens(tokens) {
    let startIndex = 0;
    let endIndex = tokens.length - 1;

    while (startIndex <= endIndex && tokens[startIndex].token_type === "COMMENT") {
      startIndex++;
    }

    while (endIndex >= startIndex && tokens[endIndex].token_type === "COMMENT") {
      endIndex--;
    }

    return tokens.slice(startIndex, endIndex + 1);
  }

  /**
   * Token配列を確認用のSQL断片へ戻す。
   *
   * Lexerは空白Tokenを保持しないため、完全な原文復元ではない。
   * この文字列は解析結果の確認・ログ・デバッグ用途であり、
   * SQL再実行用の厳密な再構築を目的としない。
   *
   * @param {Array<object>} tokens
   * @returns {string}
   */
  #tokensToText(tokens) {
    return tokens.map((token) => token.token).join("");
  }
}

module.exports = {
  SelectParser
};
