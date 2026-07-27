/**
 * 各Query ScopeのSELECT項目から、そのQueryが外部へ公開する出力列を確定する。
 *
 * OutputColumnResolverの責務:
 *
 * - SELECT項目と出力列名を対応付ける。
 * - 各出力列へExpression ASTを保持する。
 * - CTE列名一覧が指定されている場合、SELECT側の名前を列番号で上書きする。
 * - `*` / `alias.*`を、物理スキーマ展開前のWildcardとして保持する。
 * - 同名出力列や名前を導出できない式を診断情報として記録する。
 *
 * このResolverはWildcardを実カラムへ展開しない。
 * 物理テーブルのスキーマが必要な処理はPhysicalColumnResolverへ委譲する。
 */
class OutputColumnResolver {
  constructor(tokens) {
    if (!Array.isArray(tokens)) {
      throw new TypeError("OutputColumnResolver: tokens must be an array.");
    }

    this.tokens = tokens;
    this.nextOutputColumnId = 1;
    this.queryByScopeId = new Map();
  }

  /**
   * ResolutionContextに登録済みのQuery ASTとSource Resolutionを利用し、
   * Query Scopeごとの出力列一覧を作成する。
   *
   * @param {ResolutionContext} context
   * @returns {object}
   */
  resolve(context) {
    this.#validateContext(context);

    this.nextOutputColumnId = 1;
    this.queryByScopeId = new Map();
    this.#mapQueriesToScopes(
      context.query_ast,
      context.source_resolution
    );

    const scopes = [];

    for (const sourceScope of context.source_resolution.scopes) {
      const queryAst = this.queryByScopeId.get(sourceScope.scope_id);

      if (!queryAst) {
        continue;
      }

      scopes.push(
        this.#resolveScopeOutputColumns(queryAst, sourceScope, context)
      );
    }

    const result = {
      node_type: "OUTPUT_COLUMN_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      scopes,
      output_columns: scopes.flatMap((scope) => scope.output_columns)
    };

    context.setOutputColumnResolution(result);
    return result;
  }

  /**
   * Query ASTとSource Scopeをtoken_seq範囲で対応付ける。
   *
   * SourceResolverと同じQueryを参照する必要があるため、
   * start/end token_seqをQueryの安定した識別情報として利用する。
   */
  #mapQueriesToScopes(rootQueryAst, sourceResolution) {
    const queries = [];
    this.#collectQueryAsts(rootQueryAst, queries);

    for (const scope of sourceResolution.scopes) {
      const queryAst = queries.find((query) => {
        return query.start_token_seq === scope.query_start_token_seq &&
          query.end_token_seq === scope.query_end_token_seq;
      });

      if (queryAst) {
        this.queryByScopeId.set(scope.scope_id, queryAst);
      }
    }
  }

  #collectQueryAsts(queryAst, result) {
    result.push(queryAst);

    for (const setOperation of queryAst.set_operations || []) {
      if (setOperation.query?.node_type === "QUERY") {
        this.#collectQueryAsts(setOperation.query, result);
      }
    }

    for (const cte of queryAst.common_table_expressions || []) {
      if (cte.query?.node_type === "QUERY") {
        this.#collectQueryAsts(cte.query, result);
      }
    }

    const sources = [];

    if (queryAst.from?.source) {
      sources.push(queryAst.from.source);
    }

    for (const join of queryAst.from?.joins || []) {
      sources.push(join.source);
    }

    for (const source of sources) {
      if (source.query_ast?.node_type === "QUERY") {
        this.#collectQueryAsts(source.query_ast, result);
      }
    }
    const expressionNodes = [];
    for (const item of queryAst.select || []) {
      if (item.expression_ast) expressionNodes.push(item.expression_ast);
    }
    for (const expressionNode of expressionNodes) {
      this.#collectExpressionSubqueries(expressionNode, result);
    }

  }


  #collectExpressionSubqueries(node, result) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) this.#collectExpressionSubqueries(item, result);
      return;
    }
    if (
      node.node_type === NodeType.SUBQUERY_EXPRESSION &&
      node.query_ast?.node_type === "QUERY"
    ) {
      this.#collectQueryAsts(node.query_ast, result);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") this.#collectExpressionSubqueries(value, result);
    }
  }

  /**
   * 後続処理が列名で参照するQuery Scopeだけ、無名出力を警告対象にする。
   *
   * EXPRESSION_SUBQUERYは、外側のSELECT項目が公開列名を持つため、
   * 内部SELECTの集約式やSELECT 1自体に列名がなくても問題にならない。
   */
  #requiresResolvableOutputName(scopeType) {
    return scopeType !== "EXPRESSION_SUBQUERY";
  }

  /**
   * 1つのQuery ScopeについてSELECT項目を出力列へ変換する。
   */
  #resolveScopeOutputColumns(queryAst, sourceScope, context) {
    const cteColumnNames = this.#findCteColumnNames(
      context.source_resolution,
      sourceScope.scope_id
    );
    const outputColumns = [];

    for (const selectItem of queryAst.select || []) {
      const expressionAst = selectItem.wildcard_type
        ? null
        : this.#parseSelectItemExpression(selectItem);
      const cteOverrideName = cteColumnNames[selectItem.select_item_seq - 1] || null;
      const outputName = cteOverrideName || selectItem.output_alias || null;
      const outputStatus = this.#determineOutputStatus(selectItem, outputName);

      const outputColumn = {
        output_column_id: this.nextOutputColumnId++,
        output_column_seq: selectItem.select_item_seq,
        scope_id: sourceScope.scope_id,
        output_column_name: outputName,
        original_output_alias: selectItem.output_alias,
        alias_type: selectItem.alias_type,
        name_source: cteOverrideName
          ? "CTE_COLUMN_LIST"
          : selectItem.output_alias
            ? selectItem.alias_type
            : "NONE",
        output_status: outputStatus,
        wildcard_type: selectItem.wildcard_type,
        wildcard_qualifier: selectItem.wildcard_qualifier,
        wildcard_exclusions: selectItem.wildcard_exclusions || [],
        wildcard_replacements: selectItem.wildcard_replacements || [],
        expression: expressionAst,
        expression_text: selectItem.expression,
        start_token_seq: selectItem.item_start_seq,
        end_token_seq: selectItem.item_end_seq
      };

      outputColumns.push(outputColumn);

      if (
        outputStatus === "UNNAMED" &&
        this.#requiresResolvableOutputName(sourceScope.scope_type)
      ) {
        context.addDiagnostic(
          "WARNING",
          "OUTPUT_COLUMN_NAME_UNRESOLVED",
          `Output column ${selectItem.select_item_seq} in scope ` +
          `${sourceScope.scope_id} has no resolvable name.`,
          {
            scope_id: sourceScope.scope_id,
            output_column_seq: selectItem.select_item_seq,
            start_token_seq: selectItem.item_start_seq,
            end_token_seq: selectItem.item_end_seq
          }
        );
      }
    }

    this.#appendPivotGeneratedColumns(queryAst, sourceScope, outputColumns);
    this.#addDuplicateNameDiagnostics(outputColumns, sourceScope, context);

    if (cteColumnNames.length > 0 && cteColumnNames.length !== outputColumns.length) {
      context.addDiagnostic(
        "ERROR",
        "CTE_COLUMN_COUNT_MISMATCH",
        `CTE column list has ${cteColumnNames.length} names but query scope ` +
        `${sourceScope.scope_id} exposes ${outputColumns.length} SELECT items.`,
        { scope_id: sourceScope.scope_id }
      );
    }

    return {
      scope_id: sourceScope.scope_id,
      scope_type: sourceScope.scope_type,
      output_columns: outputColumns
    };
  }


  /**
   * SELECT * FROM source PIVOT(...) が生成する列を明示的なOutput Columnとして追加する。
   *
   * PIVOT生成列はSELECTリストに直接現れないため、従来は後続Queryから
   * PC_SALES等を参照した際に同一scopeの列へ戻り、自己循環と誤判定していた。
   * 集計対象列とIN句Aliasの対応を保持し、LineageResolverが入力scopeへ辿れるようにする。
   */
  #appendPivotGeneratedColumns(queryAst, sourceScope, outputColumns) {
    const parsedSource = queryAst.from?.source;
    const resolvedSource = sourceScope.sources?.[0];
    const operators = parsedSource?.relation_operators || [];
    const pivot = operators.find((operator) => operator.operator_type === "PIVOT");

    if (!pivot || !resolvedSource) {
      return;
    }

    const bodyTokens = this.tokens.filter((token) => {
      return token.token_seq >= pivot.body_start_token_seq &&
        token.token_seq <= pivot.body_end_token_seq &&
        token.token_type !== "COMMENT";
    });
    const forIndex = bodyTokens.findIndex((token) => token.normalized_token === "FOR");
    const inIndex = bodyTokens.findIndex((token, index) => {
      return index > forIndex && token.normalized_token === "IN";
    });

    if (forIndex < 0 || inIndex < 0) {
      return;
    }

    const aggregateTokens = bodyTokens.slice(0, forIndex);
    const aggregateOpenIndex = aggregateTokens.findIndex((token) => token.token === "(");
    const aggregateCloseIndex = aggregateTokens.map((token) => token.token).lastIndexOf(")");
    const valueToken = aggregateOpenIndex >= 0 && aggregateCloseIndex > aggregateOpenIndex
      ? aggregateTokens.slice(aggregateOpenIndex + 1, aggregateCloseIndex)
          .find((token) => token.token_type === "IDENTIFIER" || token.token_type === "KEYWORD")
      : null;

    if (!valueToken) {
      return;
    }

    const inputScopeId = resolvedSource.subquery_scope_id ??
      resolvedSource.cte_query_scope_id ?? null;
    let nextSeq = outputColumns.reduce((max, column) => {
      return Math.max(max, column.output_column_seq || 0);
    }, 0) + 1;

    for (let index = inIndex + 1; index < bodyTokens.length; index += 1) {
      if (bodyTokens[index].normalized_token !== "AS") {
        continue;
      }

      const aliasToken = bodyTokens[index + 1];
      if (!aliasToken) {
        continue;
      }

      const outputName = this.#normalizeName(aliasToken.token);
      outputColumns.push({
        output_column_id: this.nextOutputColumnId++,
        output_column_seq: nextSeq++,
        scope_id: sourceScope.scope_id,
        output_column_name: outputName,
        original_output_alias: outputName,
        alias_type: "PIVOT_ALIAS",
        name_source: "PIVOT_IN_ALIAS",
        output_status: "PIVOT_GENERATED",
        wildcard_type: null,
        wildcard_qualifier: null,
        wildcard_exclusions: [],
        wildcard_replacements: [],
        expression: null,
        expression_text: aggregateTokens.map((token) => token.token).join(""),
        pivot_input_scope_id: inputScopeId,
        pivot_value_column_name: this.#normalizeName(valueToken.token),
        start_token_seq: aliasToken.token_seq,
        end_token_seq: aliasToken.token_seq
      });
    }
  }

  /**
   * SELECT項目のtoken_seq範囲をExpressionParserへ渡し、ASTを作る。
   *
   * SelectParserは式の境界とaliasを決めることに集中しているため、
   * 式内部のASTはここで既存ExpressionParserを再利用して作成する。
   */
  #parseSelectItemExpression(selectItem) {
    const expressionTokens = this.tokens.filter((token) => {
      return token.token_seq >= selectItem.expression_start_seq &&
        token.token_seq <= selectItem.expression_end_seq &&
        token.token_type !== "COMMENT";
    });

    if (expressionTokens.length === 0) {
      throw new SyntaxError(
        `OutputColumnResolver: SELECT item ${selectItem.select_item_seq} ` +
        "contains no expression tokens."
      );
    }

    try {
      return new ExpressionParser(expressionTokens).parseExpression();
    } catch (error) {
      return createRawExpressionAst(expressionTokens);
    }
  }

  #determineOutputStatus(selectItem, outputName) {
    if (selectItem.wildcard_type) {
      return "WILDCARD_PENDING";
    }

    if (!outputName) {
      return "UNNAMED";
    }

    return "RESOLVED";
  }

  /**
   * CTE名の直後に `(column_a, column_b)` が指定されている場合、
   * その列名一覧はCTE本文Queryの出力名を位置順に上書きする。
   */
  #findCteColumnNames(sourceResolution, queryScopeId) {
    for (const scope of sourceResolution.scopes) {
      const definition = scope.cte_definitions.find(
        (cte) => cte.query_scope_id === queryScopeId
      );

      if (definition) {
        return Array.isArray(definition.column_names)
          ? definition.column_names.map((name) => this.#normalizeName(name))
          : [];
      }
    }

    return [];
  }

  #addDuplicateNameDiagnostics(outputColumns, sourceScope, context) {
    const countByName = new Map();

    for (const outputColumn of outputColumns) {
      if (!outputColumn.output_column_name || outputColumn.wildcard_type) {
        continue;
      }

      const name = this.#normalizeName(outputColumn.output_column_name);
      countByName.set(name, (countByName.get(name) || 0) + 1);
    }

    for (const [name, count] of countByName.entries()) {
      if (count < 2) {
        continue;
      }

      context.addDiagnostic(
        "WARNING",
        "DUPLICATE_OUTPUT_COLUMN_NAME",
        `Output column name "${name}" appears ${count} times in scope ` +
        `${sourceScope.scope_id}.`,
        { scope_id: sourceScope.scope_id, output_column_name: name }
      );
    }
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("OutputColumnResolver.resolve: invalid context.");
    }

    if (!context.source_resolution) {
      throw new TypeError(
        "OutputColumnResolver.resolve: source_resolution is not set."
      );
    }
  }

  #normalizeName(value) {
    return String(value ?? "").toUpperCase();
  }
}
