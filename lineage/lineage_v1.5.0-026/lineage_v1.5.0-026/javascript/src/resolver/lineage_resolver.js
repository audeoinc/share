/**
 * Queryの出力列から、最終的な物理テーブル・物理カラムまで依存関係を辿る。
 *
 * LineageResolverの責務:
 *
 * - OutputColumnResolverが作成した出力列と、そのSELECT式内のColumn参照を結び付ける。
 * - 物理カラム参照はLineageの終点として登録する。
 * - CTE / FROMサブクエリの参照は、対象Query Scopeの出力列へ移動して再帰展開する。
 * - 複数段CTEでも、最終的な物理カラムへ到達するまで経路を保持する。
 * - 循環参照、未解決参照、曖昧参照を診断情報として残す。
 *
 * このResolverはSQLを再解析しない。
 * Parserと前段Resolverが作成した情報を結び付けることだけに集中する。
 */
class LineageResolver {
  constructor() {
    this.scopeById = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.physicalReferenceByColumnReferenceId = new Map();
    this.referencesByOutputKey = new Map();
    this.referencesByScopeId = new Map();
    this.wildcardExpansionsByScopeAndName = new Map();
    this.nextLineageId = 1;
    this.context = null;
  }

  /**
   * ResolutionContextへ登録済みの結果を利用して、出力列Lineageを作成する。
   */
  resolve(context) {
    this.#validateContext(context);

    this.context = context;
    this.nextLineageId = 1;
    this.#buildIndexes(context);

    const outputLineages = [];

    for (const outputColumn of context.output_column_resolution.output_columns) {
      outputLineages.push(this.#resolveOutputColumn(outputColumn, [], new Set()));
    }

    /*
     * SELECT *はOutputColumnResolverでは元のWildcard項目を1件のまま保持し、
     * PhysicalColumnResolverのwildcard_expansionsで公開列一覧へ展開される。
     *
     * Lineageの利用者が通常のSELECT列と同じ形で参照できるよう、ここで
     * 展開列ごとの独立したOutput Lineageへ昇格する。元Wildcard Lineageも
     * SQL構造の監査情報として残す。
     */
    outputLineages.push(...this.#resolveExpandedWildcardOutputs(context));

    const rootOutputLineages = outputLineages.filter((lineage) => {
      return lineage.output_scope_id === context.source_resolution.root_scope_id;
    });

    const result = {
      node_type: "LINEAGE_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      output_lineages: outputLineages,
      root_output_lineages: rootOutputLineages,
      physical_dependencies: this.#flattenPhysicalDependencies(rootOutputLineages)
    };

    context.setLineageResolution(result);
    this.#addDiagnostics(result, context);

    return result;
  }

  #resolveExpandedWildcardOutputs(context) {
    const lineages = [];

    for (const expansion of context.physical_column_resolution.wildcard_expansions) {
      const outputName = this.#normalizeName(expansion.output_column_name);
      const lineagePath = [
        `SCOPE_${expansion.scope_id}.${outputName}`,
        `WILDCARD_EXPANSION:${expansion.select_item_seq}.${expansion.expanded_column_seq}`
      ];
      let dependencies = [];

      if (expansion.wildcard_replacement) {
        const replacement = expansion.wildcard_replacement;
        const references = (this.referencesByScopeId.get(expansion.scope_id) || []).filter((reference) => {
          return reference.clause_type === "SELECT" &&
            reference.select_item_seq === expansion.select_item_seq &&
            reference.start_token_seq >= replacement.expression_start_seq &&
            reference.end_token_seq <= replacement.expression_end_seq;
        });
        for (const reference of references) {
          dependencies.push(...this.#resolveReference(reference, lineagePath, new Set()));
        }
      } else if (expansion.physical_table_name && expansion.physical_column_name) {
        dependencies.push({
          dependency_type: "PHYSICAL_COLUMN",
          dependency_status: "RESOLVED",
          physical_table_name: expansion.physical_table_name,
          physical_column_name: expansion.physical_column_name,
          field_path: expansion.field_path,
          source_reference_name: expansion.wildcard_expression || "*",
          lineage_path: [
            ...lineagePath,
            `${expansion.physical_table_name}.${expansion.field_path || expansion.physical_column_name}`
          ]
        });
      } else {
        const source = this.sourceById.get(expansion.source_id);
        const childScopeId = source?.cte_query_scope_id ??
          source?.subquery_scope_id ??
          this.#findVisibleCteDefinition(source?.scope_id, source?.source_name)?.query_scope_id ??
          null;

        if (childScopeId !== null) {
          const childOutput = this.#findOutputColumn(childScopeId, outputName);

          if (childOutput) {
            const nestedLineage = this.#resolveOutputColumn(
              childOutput,
              lineagePath,
              new Set()
            );
            dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
              ...dependency,
              via_wildcard_scope_id: expansion.scope_id,
              via_derived_scope_id: childScopeId,
              via_derived_output_column_name: childOutput.output_column_name
            })));
          } else {
            const syntheticReference = {
              reference_name: outputName,
              column_name: outputName,
              field_path: null,
              scope_id: expansion.scope_id
            };
            dependencies.push(...this.#resolveDerivedWildcardColumn(
              childScopeId,
              outputName,
              syntheticReference,
              lineagePath,
              new Set()
            ));
          }
        }
      }

      dependencies = this.#deduplicateDependencies(dependencies);

      lineages.push({
        lineage_id: this.nextLineageId++,
        output_column_id: `WILDCARD_${expansion.expanded_output_column_id}`,
        output_scope_id: expansion.scope_id,
        output_column_seq: expansion.select_item_seq,
        expanded_column_seq: expansion.expanded_column_seq,
        output_column_name: outputName,
        expression_text: expansion.wildcard_expression || "*",
        lineage_status: dependencies.length === 0
          ? "UNRESOLVED"
          : dependencies.some((dependency) => dependency.dependency_status !== "RESOLVED")
            ? "PARTIALLY_RESOLVED"
            : "RESOLVED",
        dependencies,
        lineage_path: lineagePath,
        start_token_seq: null,
        end_token_seq: null,
        expanded_from_wildcard: true,
        source_output_column_id: expansion.source_output_column_id
      });
    }

    return lineages;
  }

  #buildIndexes(context) {
    this.scopeById = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.physicalReferenceByColumnReferenceId = new Map();
    this.referencesByOutputKey = new Map();
    this.referencesByScopeId = new Map();
    this.wildcardExpansionsByScopeAndName = new Map();

    for (const scope of context.source_resolution.scopes) {
      this.scopeById.set(scope.scope_id, scope);

      for (const source of scope.sources) {
        this.sourceById.set(source.source_id, source);
      }
    }

    for (const scope of context.output_column_resolution.scopes) {
      this.outputColumnsByScopeId.set(scope.scope_id, scope.output_columns);
    }

    for (const physicalReference of context.physical_column_resolution.column_references) {
      this.physicalReferenceByColumnReferenceId.set(
        physicalReference.column_reference_id,
        physicalReference
      );
    }

    for (const expansion of context.physical_column_resolution.wildcard_expansions) {
      const key = this.#createWildcardExpansionKey(
        expansion.scope_id,
        expansion.output_column_name
      );

      if (!this.wildcardExpansionsByScopeAndName.has(key)) {
        this.wildcardExpansionsByScopeAndName.set(key, []);
      }

      this.wildcardExpansionsByScopeAndName.get(key).push(expansion);
    }

    /*
     * SELECT項目ごとにColumn参照をまとめる。
     * OutputColumnのoutput_column_seqとColumnResolverのselect_item_seqが対応する。
     */
    for (const reference of context.column_resolution.column_references) {
      if (!this.referencesByScopeId.has(reference.scope_id)) {
        this.referencesByScopeId.set(reference.scope_id, []);
      }

      this.referencesByScopeId.get(reference.scope_id).push(reference);

      if (reference.clause_type !== "SELECT" || reference.select_item_seq === null) {
        continue;
      }

      const key = this.#createOutputKey(reference.scope_id, reference.select_item_seq);

      if (!this.referencesByOutputKey.has(key)) {
        this.referencesByOutputKey.set(key, []);
      }

      this.referencesByOutputKey.get(key).push(reference);
    }
  }

  #resolveOutputColumn(outputColumn, parentPath, visitingOutputIds) {
    const pathEntry = this.#createOutputPathEntry(outputColumn);
    const lineagePath = [...parentPath, pathEntry];

    if (visitingOutputIds.has(outputColumn.output_column_id)) {
      return {
        lineage_id: this.nextLineageId++,
        output_column_id: outputColumn.output_column_id,
        output_scope_id: outputColumn.scope_id,
        output_column_name: outputColumn.output_column_name,
        lineage_status: "CYCLE_DETECTED",
        dependencies: [],
        lineage_path: lineagePath
      };
    }

    const nextVisiting = new Set(visitingOutputIds);
    nextVisiting.add(outputColumn.output_column_id);

    if (outputColumn.output_status === "WILDCARD_PENDING") {
      return this.#resolveWildcardOutput(outputColumn, lineagePath);
    }

    if (outputColumn.output_status === "PIVOT_GENERATED") {
      return this.#resolvePivotGeneratedOutput(
        outputColumn,
        lineagePath,
        nextVisiting
      );
    }

    const key = this.#createOutputKey(
      outputColumn.scope_id,
      outputColumn.output_column_seq
    );
    const references = this.referencesByOutputKey.get(key) || [];
    const dependencies = [];

    for (const reference of references) {
      dependencies.push(
        ...this.#resolveReference(reference, lineagePath, nextVisiting)
      );
    }

    /*
     * ARRAY(SELECT ... FROM UNNEST(array_column)) の内側Queryは、
     * ColumnResolver上では独立したEXPRESSION_SUBQUERYスコープになる。
     * そのままでは親SELECT項目の参照一覧へ依存が戻らないため、
     * UNNEST元の配列列を親スコープで再解決し、配列を生成した物理列へ伝播する。
     */
    dependencies.push(
      ...this.#resolveExpressionSubqueryDependencies(
        outputColumn,
        lineagePath,
        nextVisiting
      )
    );

    /*
     * UNION / UNION ALL / UNION DISTINCTの公開列名は先頭branchから継承するが、
     * リネージは同じ列位置にある全branchの依存を持つ必要がある。
     * SourceResolverが保持するset_operationsの子scopeを列位置で対応付け、
     * 各branchのOutputColumnを再帰解決して依存集合へ統合する。
     */
    dependencies.push(
      ...this.#resolveSetOperationDependencies(
        outputColumn,
        lineagePath,
        nextVisiting
      )
    );

    const uniqueDependencies = this.#deduplicateDependencies(dependencies);

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: this.#determineLineageStatus(references, uniqueDependencies),
      dependencies: uniqueDependencies,
      lineage_path: lineagePath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }


  #resolveSetOperationDependencies(
    outputColumn,
    lineagePath,
    visitingOutputIds
  ) {
    const scope = this.scopeById.get(outputColumn.scope_id);
    const setOperations = Array.isArray(scope?.set_operations)
      ? scope.set_operations
      : [];

    if (setOperations.length === 0) {
      return [];
    }

    const dependencies = [];

    for (const setOperation of setOperations) {
      const branchOutputs = this.outputColumnsByScopeId.get(
        setOperation.query_scope_id
      ) || [];
      const branchOutput = branchOutputs.find((candidate) => {
        return candidate.output_column_seq === outputColumn.output_column_seq;
      });

      if (!branchOutput) {
        continue;
      }

      const branchLineage = this.#resolveOutputColumn(
        branchOutput,
        lineagePath,
        visitingOutputIds
      );

      dependencies.push(...branchLineage.dependencies.map((dependency) => ({
        ...dependency,
        via_set_operation: setOperation.operator,
        via_set_operation_modifier: setOperation.modifier,
        via_set_operation_scope_id: setOperation.query_scope_id,
        via_set_operation_column_seq: outputColumn.output_column_seq
      })));
    }

    return this.#deduplicateDependencies(dependencies);
  }


  #resolveExpressionSubqueryDependencies(
    outputColumn,
    lineagePath,
    visitingOutputIds
  ) {
    const subqueryNodes = [];
    this.#collectExpressionSubqueryNodes(outputColumn.expression, subqueryNodes);

    if (subqueryNodes.length === 0) {
      return [];
    }

    const dependencies = [];

    for (const subqueryNode of subqueryNodes) {
      const queryAst = subqueryNode.query_ast;
      const childScope = Array.from(this.scopeById.values()).find((scope) => {
        return scope.query_start_token_seq === queryAst.start_token_seq &&
          scope.query_end_token_seq === queryAst.end_token_seq;
      });

      if (!childScope) {
        continue;
      }

      /*
       * Scalar Subqueryは子Queryの先頭出力列を1つの値として親式へ返す。
       * 子スコープ側のOutputColumnは既に通常のLineageとして解決できるため、
       * その依存関係を親SELECT項目へ伝播する。
       *
       * ARRAY Subqueryは複数行を配列化するため、ここでは従来どおり
       * UNNEST元コレクションを経由する専用処理へ任せる。
       */
      if (subqueryNode.node_type === NodeType.SUBQUERY_EXPRESSION) {
        const childOutputs = this.outputColumnsByScopeId.get(childScope.scope_id) || [];
        const scalarOutput = childOutputs.find((candidate) => {
          return candidate.output_column_seq === 1;
        });

        if (scalarOutput) {
          const scalarLineage = this.#resolveOutputColumn(
            scalarOutput,
            lineagePath,
            visitingOutputIds
          );

          dependencies.push(...scalarLineage.dependencies.map((dependency) => ({
            ...dependency,
            via_expression_subquery_scope_id: childScope.scope_id,
            via_scalar_subquery_output_column_name:
              scalarOutput.output_column_name ?? null
          })));
        }

        dependencies.push(
          ...this.#resolveCorrelatedSubqueryDependencies(
            childScope,
            lineagePath,
            visitingOutputIds
          )
        );
      }

      const unnestSources = (childScope.sources || []).filter((source) => {
        return source.source_type === "UNNEST" && source.expression;
      });

      for (const unnestSource of unnestSources) {
        const collectionName = this.#extractSimpleIdentifierName(
          unnestSource.expression
        );

        if (!collectionName) {
          continue;
        }

        const parentScope = this.scopeById.get(childScope.parent_scope_id);
        const candidates = [];

        for (const source of parentScope?.sources || []) {
          const sourceScopeId = source.cte_query_scope_id ??
            source.subquery_scope_id ??
            this.#findVisibleCteDefinition(
              source.scope_id,
              source.source_name
            )?.query_scope_id ?? null;

          if (sourceScopeId === null) {
            continue;
          }

          const targetOutput = this.#findOutputColumn(
            sourceScopeId,
            collectionName
          );

          if (targetOutput) {
            candidates.push(targetOutput);
          }
        }

        if (candidates.length !== 1) {
          continue;
        }

        const nestedLineage = this.#resolveOutputColumn(
          candidates[0],
          lineagePath,
          visitingOutputIds
        );

        dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
          ...dependency,
          via_expression_subquery_scope_id: childScope.scope_id,
          via_unnest_collection_name: collectionName
        })));
      }
    }

    return this.#deduplicateDependencies(dependencies);
  }

  #resolveCorrelatedSubqueryDependencies(
    childScope,
    lineagePath,
    visitingOutputIds
  ) {
    const references = this.referencesByScopeId.get(childScope.scope_id) || [];
    const predicateReferences = references.filter((reference) => {
      return reference.clause_type !== "SELECT";
    });

    /*
     * 相関Subqueryでは、子QueryのWHERE / JOIN / HAVING等に
     * 親QueryのSourceを参照するColumnReferenceが含まれる。
     * 外側参照が1つもなければ通常のScalar Subqueryなので、
     * 条件列を出力リネージへ追加しない。
     */
    const hasOuterReference = predicateReferences.some((reference) => {
      const source = this.sourceById.get(reference.source_id);

      if (!source) {
        return false;
      }

      return this.#isAncestorScope(source.scope_id, childScope.scope_id);
    });

    if (!hasOuterReference) {
      return [];
    }

    const dependencies = [];

    /*
     * 相関条件は内側列と外側列の双方で結果行を決定する。
     * そのため外側参照だけでなく、同じ子Scopeの条件句に現れる
     * 全ColumnReferenceを親SELECT項目の依存関係へ統合する。
     */
    for (const reference of predicateReferences) {
      dependencies.push(
        ...this.#resolveReference(reference, lineagePath, visitingOutputIds)
          .map((dependency) => ({
            ...dependency,
            via_correlated_subquery_scope_id: childScope.scope_id,
            via_correlated_clause_type: reference.clause_type
          }))
      );
    }

    /*
     * EXISTS / Scalar Subqueryの条件内に、さらに相関Subqueryが入れ子に
     * なる場合がある。最内層の条件列も外側SELECT値の成立条件となるため、
     * 直接の子Scopeを再帰的に解決して依存関係へ伝播する。
     */
    const nestedScopes = Array.from(this.scopeById.values()).filter((scope) => {
      return scope.parent_scope_id === childScope.scope_id;
    });

    for (const nestedScope of nestedScopes) {
      dependencies.push(
        ...this.#resolveCorrelatedSubqueryDependencies(
          nestedScope,
          lineagePath,
          visitingOutputIds
        ).map((dependency) => ({
          ...dependency,
          via_nested_correlated_subquery_scope_id: nestedScope.scope_id
        }))
      );
    }

    return this.#deduplicateDependencies(dependencies);
  }

  #isAncestorScope(ancestorScopeId, childScopeId) {
    if (ancestorScopeId === null || ancestorScopeId === undefined) {
      return false;
    }

    let currentScope = this.scopeById.get(childScopeId);

    while (currentScope?.parent_scope_id !== null &&
           currentScope?.parent_scope_id !== undefined) {
      if (currentScope.parent_scope_id === ancestorScopeId) {
        return true;
      }

      currentScope = this.scopeById.get(currentScope.parent_scope_id);
    }

    return false;
  }

  #collectExpressionSubqueryNodes(node, result) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.#collectExpressionSubqueryNodes(item, result);
      }
      return;
    }

    if (
      (node.node_type === NodeType.SUBQUERY_EXPRESSION ||
       node.node_type === NodeType.ARRAY_SUBQUERY_EXPRESSION) &&
      node.query_ast?.node_type === "QUERY"
    ) {
      result.push(node);
      return;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        this.#collectExpressionSubqueryNodes(value, result);
      }
    }
  }

  #extractSimpleIdentifierName(expression) {
    if (expression?.node_type !== NodeType.IDENTIFIER_EXPRESSION) {
      return null;
    }

    const parts = Array.isArray(expression.parts)
      ? expression.parts.filter((part) => part !== ".")
      : [];

    const lastPart = parts.at(-1);
    const rawName = parts.length > 0
      ? typeof lastPart === "string"
        ? lastPart
        : lastPart?.normalized_token ?? lastPart?.token
      : expression.name;

    return rawName ? this.#normalizeName(rawName) : null;
  }


  #resolvePivotGeneratedOutput(outputColumn, lineagePath, visitingOutputIds) {
    const inputScopeId = outputColumn.pivot_input_scope_id;
    const targetOutput = this.#findOutputColumn(
      inputScopeId,
      outputColumn.pivot_value_column_name
    );

    if (!targetOutput) {
      return {
        lineage_id: this.nextLineageId++,
        output_column_id: outputColumn.output_column_id,
        output_scope_id: outputColumn.scope_id,
        output_column_seq: outputColumn.output_column_seq,
        output_column_name: outputColumn.output_column_name,
        expression_text: outputColumn.expression_text,
        lineage_status: "UNRESOLVED",
        dependencies: [],
        lineage_path: lineagePath,
        start_token_seq: outputColumn.start_token_seq,
        end_token_seq: outputColumn.end_token_seq
      };
    }

    const nestedLineage = this.#resolveOutputColumn(
      targetOutput,
      lineagePath,
      visitingOutputIds
    );

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: nestedLineage.lineage_status,
      dependencies: nestedLineage.dependencies.map((dependency) => ({
        ...dependency,
        via_pivot_scope_id: outputColumn.scope_id,
        via_pivot_output_column_name: outputColumn.output_column_name,
        via_pivot_value_column_name: outputColumn.pivot_value_column_name
      })),
      lineage_path: lineagePath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }

  #resolveReference(reference, parentPath, visitingOutputIds) {
    const physicalReference = this.physicalReferenceByColumnReferenceId.get(
      reference.column_reference_id
    );

    if (!physicalReference) {
      return [this.#createUnresolvedDependency(reference, parentPath, "PHYSICAL_REFERENCE_MISSING")];
    }

    if (physicalReference.physical_resolution_status === "PHYSICAL_RESOLVED") {
      return physicalReference.physical_columns.map((column) => {
        return {
          dependency_type: "PHYSICAL_COLUMN",
          dependency_status: "RESOLVED",
          physical_table_name: column.physical_table_name,
          physical_column_name: column.physical_column_name,
          field_path: column.field_path,
          source_reference_name: reference.reference_name,
          lineage_path: [
            ...parentPath,
            `${column.physical_table_name}.${column.field_path || column.physical_column_name}`
          ]
        };
      });
    }

    let derivedScopeId = this.#findDerivedSourceScope(reference, physicalReference);

    /*
     * PIVOT生成列はColumnResolver実行時点ではSELECTリストに存在しない。
     * そのため非修飾参照のsource_idが未設定になる場合がある。
     * 現scopeに派生Sourceが1件だけなら、その公開列へ安全にフォールバックする。
     */
    if (derivedScopeId === null) {
      const currentScope = this.scopeById.get(reference.scope_id);
      const derivedSources = (currentScope?.sources || []).filter((source) => {
        return source.cte_query_scope_id !== null || source.subquery_scope_id !== null;
      });

      if (derivedSources.length === 1) {
        derivedScopeId = derivedSources[0].cte_query_scope_id ??
          derivedSources[0].subquery_scope_id ?? null;
      }
    }

    /*
     * 親SUBQUERYのSourceが誤って候補になった場合、derivedScopeIdが現在scope自身を
     * 指して自己循環になる。現在scopeに実際の派生Sourceが1件だけある場合は、
     * そのCTE/SUBQUERYの公開scopeへ補正する。PIVOT列を外側SUBQUERYで列挙する
     * ケース（SELECT pc_sales FROM pivoted_cte）で必要になる。
     */
    if (derivedScopeId === reference.scope_id) {
      const currentScope = this.scopeById.get(reference.scope_id);
      const localDerivedSources = (currentScope?.sources || []).filter((source) => {
        const childScopeId = source.cte_query_scope_id ?? source.subquery_scope_id ?? null;
        return childScopeId !== null && childScopeId !== reference.scope_id;
      });

      if (localDerivedSources.length === 1) {
        derivedScopeId = localDerivedSources[0].cte_query_scope_id ??
          localDerivedSources[0].subquery_scope_id ?? null;
      }
    }

    if (derivedScopeId !== null) {
      const targetOutput = this.#findOutputColumn(
        derivedScopeId,
        reference.column_name
      );

      if (!targetOutput) {
        const wildcardDependencies = this.#resolveDerivedWildcardColumn(
          derivedScopeId,
          reference.column_name,
          reference,
          parentPath,
          visitingOutputIds
        );

        if (wildcardDependencies.length > 0) {
          return wildcardDependencies;
        }

        return [this.#createUnresolvedDependency(
          reference,
          parentPath,
          "DERIVED_OUTPUT_COLUMN_NOT_FOUND"
        )];
      }

      let effectiveTargetOutput = targetOutput;
      if (reference.field_path) {
        const fieldTarget = this.#findStructFieldOutput(targetOutput, reference.field_path);
        if (fieldTarget) effectiveTargetOutput = fieldTarget;
      }

      const nestedLineage = this.#resolveOutputColumn(
        effectiveTargetOutput,
        parentPath,
        visitingOutputIds
      );

      if (nestedLineage.lineage_status === "CYCLE_DETECTED") {
        return [{
          dependency_type: "DERIVED_COLUMN",
          dependency_status: "CYCLE_DETECTED",
          source_reference_name: reference.reference_name,
          derived_scope_id: derivedScopeId,
          derived_output_column_name: effectiveTargetOutput.output_column_name,
          lineage_path: nestedLineage.lineage_path
        }];
      }

      if (nestedLineage.lineage_status === "NO_COLUMN_DEPENDENCY") {
        return [this.#createNoColumnDependency(
          reference,
          parentPath,
          derivedScopeId,
          effectiveTargetOutput.output_column_name
        )];
      }

      return nestedLineage.dependencies.map((dependency) => {
        return {
          ...dependency,
          dependency_type: dependency.dependency_type === "PHYSICAL_COLUMN"
            ? "PHYSICAL_COLUMN"
            : dependency.dependency_type,
          via_derived_scope_id: derivedScopeId,
          via_derived_output_column_name: effectiveTargetOutput.output_column_name
        };
      });
    }

    return [this.#createUnresolvedDependency(
      reference,
      parentPath,
      physicalReference.physical_resolution_status
    )];
  }

  /**
   * CTE / サブクエリ参照が指すQuery Scopeを返す。
   *
   * 既存SourceResolverでは、CTE本文から先に定義された兄弟CTEを参照した場合、
   * 物理テーブル候補として保持されることがある。そのためsource_typeだけでなく、
   * 親ScopeのCTE定義も検索して補正する。
   */
  #findStructFieldOutput(outputColumn, fieldPath) {
    const expression = outputColumn?.expression;
    if (!expression || expression.node_type !== NodeType.SUBQUERY_EXPRESSION || !expression.query_ast) {
      return null;
    }

    const childScope = Array.from(this.scopeById.values()).find((scope) => {
      return scope.query_start_token_seq === expression.query_ast.start_token_seq &&
        scope.query_end_token_seq === expression.query_ast.end_token_seq;
    });
    if (!childScope) return null;

    const fieldName = this.#normalizeName(String(fieldPath).split(".")[0]);
    return this.#findOutputColumn(childScope.scope_id, fieldName);
  }

  #findDerivedSourceScope(reference, physicalReference) {
    const source = this.sourceById.get(physicalReference.source_id || reference.source_id);

    if (!source) {
      return null;
    }

    if (source.source_type === "CTE" && source.cte_query_scope_id !== null) {
      return source.cte_query_scope_id;
    }

    if (source.source_type === "SUBQUERY" && source.subquery_scope_id !== null) {
      return source.subquery_scope_id;
    }

    const cteDefinition = this.#findVisibleCteDefinition(
      source.scope_id,
      source.source_name
    );

    return cteDefinition ? cteDefinition.query_scope_id : null;
  }

  #findVisibleCteDefinition(scopeId, sourceName) {
    const normalizedSourceName = this.#normalizeName(sourceName);
    let currentScope = this.scopeById.get(scopeId);

    while (currentScope) {
      const definition = currentScope.cte_definitions.find((cte) => {
        return cte.cte_name === normalizedSourceName;
      });

      if (definition) {
        return definition;
      }

      currentScope = currentScope.parent_scope_id === null
        ? null
        : this.scopeById.get(currentScope.parent_scope_id);
    }

    return null;
  }

  #findOutputColumn(scopeId, columnName) {
    const outputColumns = this.outputColumnsByScopeId.get(scopeId) || [];
    const normalizedColumnName = this.#normalizeName(columnName);

    return outputColumns.find((outputColumn) => {
      return this.#normalizeName(outputColumn.output_column_name) === normalizedColumnName;
    }) || null;
  }

  #resolveWildcardOutput(outputColumn, parentPath) {
    const expansions = this.context.physical_column_resolution.wildcard_expansions.filter(
      (item) => item.scope_id === outputColumn.scope_id &&
        item.select_item_seq === outputColumn.output_column_seq
    );

    const dependencies = expansions.map((item) => {
      return {
        dependency_type: "PHYSICAL_COLUMN",
        dependency_status: "RESOLVED",
        physical_table_name: item.physical_table_name,
        physical_column_name: item.physical_column_name,
        field_path: item.field_path,
        source_reference_name: outputColumn.wildcard_qualifier || "*",
        lineage_path: [
          ...parentPath,
          `${item.physical_table_name}.${item.field_path || item.physical_column_name}`
        ]
      };
    });

    return {
      lineage_id: this.nextLineageId++,
      output_column_id: outputColumn.output_column_id,
      output_scope_id: outputColumn.scope_id,
      output_column_seq: outputColumn.output_column_seq,
      output_column_name: outputColumn.output_column_name,
      expression_text: outputColumn.expression_text,
      lineage_status: dependencies.length > 0 ? "RESOLVED" : "UNRESOLVED",
      dependencies,
      lineage_path: parentPath,
      start_token_seq: outputColumn.start_token_seq,
      end_token_seq: outputColumn.end_token_seq
    };
  }

  #resolveDerivedWildcardColumn(
    derivedScopeId,
    columnName,
    reference,
    parentPath,
    visitingOutputIds
  ) {
    const key = this.#createWildcardExpansionKey(derivedScopeId, columnName);
    const expansions = this.wildcardExpansionsByScopeAndName.get(key) || [];
    const dependencies = [];

    for (const expansion of expansions) {
      if (expansion.physical_table_name && expansion.physical_column_name) {
        dependencies.push({
          dependency_type: "PHYSICAL_COLUMN",
          dependency_status: "RESOLVED",
          physical_table_name: expansion.physical_table_name,
          physical_column_name: expansion.physical_column_name,
          field_path: expansion.field_path,
          source_reference_name: reference.reference_name,
          lineage_path: [
            ...parentPath,
            `${expansion.physical_table_name}.${expansion.field_path || expansion.physical_column_name}`
          ]
        });
        continue;
      }

      const source = this.sourceById.get(expansion.source_id);
      const childScopeId = source?.cte_query_scope_id || source?.subquery_scope_id ||
        this.#findVisibleCteDefinition(source?.scope_id, source?.source_name)?.query_scope_id || null;

      if (childScopeId === null) {
        continue;
      }

      const childOutput = this.#findOutputColumn(childScopeId, columnName);

      if (childOutput) {
        let effectiveChildOutput = childOutput;

        /*
         * SELECT *を介してSTRUCT列が継承された場合もfield_pathを失わない。
         * 例: pure_struct_txns.* -> structured_txns.txn_info.detail_amount
         */
        if (reference.field_path) {
          const fieldOutput = this.#findStructFieldOutput(
            childOutput,
            reference.field_path
          );

          if (fieldOutput) {
            effectiveChildOutput = fieldOutput;
          }
        }

        const nestedLineage = this.#resolveOutputColumn(
          effectiveChildOutput,
          parentPath,
          visitingOutputIds
        );
        if (nestedLineage.lineage_status === "NO_COLUMN_DEPENDENCY") {
          dependencies.push(this.#createNoColumnDependency(
            reference,
            parentPath,
            childScopeId,
            effectiveChildOutput.output_column_name,
            derivedScopeId
          ));
          continue;
        }

        dependencies.push(...nestedLineage.dependencies.map((dependency) => ({
          ...dependency,
          via_derived_scope_id: childScopeId,
          via_derived_output_column_name: effectiveChildOutput.output_column_name,
          via_wildcard_scope_id: derivedScopeId
        })));
        continue;
      }

      dependencies.push(...this.#resolveDerivedWildcardColumn(
        childScopeId,
        columnName,
        reference,
        parentPath,
        visitingOutputIds
      ));
    }

    return this.#deduplicateDependencies(dependencies);
  }

  #createWildcardExpansionKey(scopeId, columnName) {
    return `${scopeId}:${this.#normalizeName(columnName)}`;
  }

  #createNoColumnDependency(
    reference,
    parentPath,
    derivedScopeId,
    outputColumnName,
    wildcardScopeId = null
  ) {
    const dependency = {
      dependency_type: "DERIVED_NO_COLUMN_DEPENDENCY",
      dependency_status: "RESOLVED",
      source_reference_name: reference.reference_name,
      derived_scope_id: derivedScopeId,
      derived_output_column_name: outputColumnName,
      lineage_path: [
        ...parentPath,
        `SCOPE_${derivedScopeId}.${outputColumnName}:NO_COLUMN_DEPENDENCY`
      ]
    };

    if (wildcardScopeId !== null) {
      dependency.via_wildcard_scope_id = wildcardScopeId;
    }

    return dependency;
  }

  #createUnresolvedDependency(reference, parentPath, status) {
    return {
      dependency_type: "UNRESOLVED_COLUMN",
      dependency_status: status,
      source_reference_name: reference.reference_name,
      scope_id: reference.scope_id,
      column_name: reference.column_name,
      lineage_path: [...parentPath, `UNRESOLVED:${reference.reference_name}`]
    };
  }

  #determineLineageStatus(references, dependencies) {
    /*
     * ARRAY subqueryなど、親SELECT項目には直接ColumnReferenceが無くても、
     * 式サブクエリから物理依存が伝播する場合がある。
     */
    if (references.length === 0 && dependencies.length === 0) {
      return "NO_COLUMN_DEPENDENCY";
    }

    if (dependencies.length === 0) {
      return "UNRESOLVED";
    }

    if (dependencies.some((dependency) => dependency.dependency_status !== "RESOLVED")) {
      return "PARTIALLY_RESOLVED";
    }

    return "RESOLVED";
  }

  #deduplicateDependencies(dependencies) {
    const result = [];
    const seen = new Set();

    for (const dependency of dependencies) {
      const key = dependency.dependency_type === "PHYSICAL_COLUMN"
        ? `${dependency.physical_table_name}|${dependency.field_path || dependency.physical_column_name}`
        : `${dependency.dependency_type}|${dependency.dependency_status}|` +
          `${dependency.source_reference_name}|${dependency.derived_scope_id ?? ""}|` +
          `${dependency.derived_output_column_name ?? ""}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(dependency);
    }

    return result;
  }

  #flattenPhysicalDependencies(rootOutputLineages) {
    const rows = [];

    for (const lineage of rootOutputLineages) {
      for (const dependency of lineage.dependencies) {
        if (dependency.dependency_type !== "PHYSICAL_COLUMN") {
          continue;
        }

        rows.push({
          output_column_id: lineage.output_column_id,
          output_column_name: lineage.output_column_name,
          output_scope_id: lineage.output_scope_id,
          physical_table_name: dependency.physical_table_name,
          physical_column_name: dependency.physical_column_name,
          field_path: dependency.field_path,
          lineage_path: dependency.lineage_path
        });
      }
    }

    return rows;
  }

  #addDiagnostics(result, context) {
    for (const lineage of result.output_lineages) {
      if (lineage.lineage_status === "RESOLVED" ||
          lineage.lineage_status === "NO_COLUMN_DEPENDENCY") {
        continue;
      }

      if (lineage.lineage_status !== "CYCLE_DETECTED" &&
          this.#hasUnderlyingError(lineage, context)) {
        continue;
      }

      context.addDiagnostic(
        lineage.lineage_status === "CYCLE_DETECTED" ? "ERROR" : "WARNING",
        `LINEAGE_${lineage.lineage_status}`,
        `Lineage for output column ${lineage.output_column_name || "<unnamed>"} ` +
        `in scope ${lineage.output_scope_id} is ${lineage.lineage_status}.`,
        {
          output_column_id: lineage.output_column_id,
          output_column_name: lineage.output_column_name,
          scope_id: lineage.output_scope_id,
          start_token_seq: lineage.start_token_seq,
          end_token_seq: lineage.end_token_seq
        }
      );
    }
  }

  #hasUnderlyingError(lineage, context) {
    const dependencyNames = new Set();

    for (const dependency of lineage.dependencies ?? []) {
      if (dependency.dependency_status === "RESOLVED") {
        continue;
      }

      const values = [
        dependency.column_name,
        dependency.source_reference_name
      ];

      for (const value of values) {
        const normalized = this.#normalizeName(value);

        if (normalized) {
          dependencyNames.add(normalized);
        }
      }
    }

    return (context.diagnostics ?? []).some((diagnostic) => {
      if (diagnostic.severity !== "ERROR") {
        return false;
      }

      if (diagnostic.scope_id !== null &&
          diagnostic.scope_id !== undefined &&
          diagnostic.scope_id !== lineage.output_scope_id) {
        return false;
      }

      const referencedName = this.#normalizeName(
        diagnostic.referenced_column_name ?? diagnostic.column_name
      );

      return referencedName && dependencyNames.has(referencedName);
    });
  }

  #createOutputPathEntry(outputColumn) {
    return `SCOPE_${outputColumn.scope_id}.${outputColumn.output_column_name || "<UNNAMED>"}`;
  }

  #createOutputKey(scopeId, outputColumnSeq) {
    return `${scopeId}:${outputColumnSeq}`;
  }

  #normalizeName(value) {
    return value === null || value === undefined
      ? null
      : String(value).toUpperCase();
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("LineageResolver.resolve: invalid ResolutionContext.");
    }

    const requiredResults = [
      ["source_resolution", "SOURCE_RESOLUTION"],
      ["column_resolution", "COLUMN_RESOLUTION"],
      ["output_column_resolution", "OUTPUT_COLUMN_RESOLUTION"],
      ["physical_column_resolution", "PHYSICAL_COLUMN_RESOLUTION"]
    ];

    for (const [propertyName, nodeType] of requiredResults) {
      if (context[propertyName]?.node_type !== nodeType) {
        throw new TypeError(
          `LineageResolver.resolve: ${propertyName} must be registered first.`
        );
      }
    }
  }
}
