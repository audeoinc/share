/**
 * ColumnResolverがSourceまで解決した参照を、物理テーブルの実カラムへ結び付ける。
 *
 * PhysicalColumnResolverの責務:
 *
 * - INFORMATION_SCHEMA.COLUMNS / COLUMN_FIELD_PATHS相当のメタデータを索引化する。
 * - PHYSICAL_TABLEへ向いたカラム参照について、実カラムの存在を確認する。
 * - 非修飾列が複数Source候補を持つ場合、実スキーマを使って候補を絞り込む。
 * - `*` / `alias.*`を、物理テーブルまたは派生Sourceの公開列へ展開する。
 * - CTEやサブクエリの参照は、次のLineageResolverが内部式を辿れるよう
 *   「派生Sourceとして解決済み」の状態で保持する。
 *
 * このResolverは、CTE出力列の式を物理カラムまで再帰展開しない。
 * その処理は次工程のLineageResolverへ委譲する。
 */
class PhysicalColumnResolver {
  /**
   * @param {Array<object>} physicalColumns
   *
   * 1行の例:
   * {
   *   project_id: "project",
   *   dataset_id: "dataset",
   *   table_name: "sales",
   *   column_name: "amount",
   *   field_path: "amount",
   *   ordinal_position: 3,
   *   data_type: "NUMERIC"
   * }
   *
   * table_nameへ`project.dataset.sales`を直接渡す形式にも対応する。
   */
  constructor(physicalColumns) {
    if (!Array.isArray(physicalColumns)) {
      throw new TypeError(
        "PhysicalColumnResolver: physicalColumns must be an array."
      );
    }

    this.physicalColumns = physicalColumns;
    this.tableColumnsByName = new Map();
    this.sourceById = new Map();
    this.outputColumnsByScopeId = new Map();
    this.nextPhysicalReferenceId = 1;
    this.nextExpandedOutputColumnId = 1;
  }

  /**
   * ResolutionContextへ登録済みのSource / Column / Output Columnを利用し、
   * 物理カラム解決結果を作る公開入口。
   */
  resolve(context) {
    this.#validateContext(context);

    this.nextPhysicalReferenceId = 1;
    this.nextExpandedOutputColumnId = 1;
    this.#buildMetadataIndex();
    this.#buildResolutionIndexes(context);

    const columnReferences = context.column_resolution.column_references.map(
      (reference) => this.#resolveColumnReference(reference, context)
    );
    const wildcardExpansions = this.#expandOutputWildcards(context);

    const result = {
      node_type: "PHYSICAL_COLUMN_RESOLUTION",
      root_scope_id: context.source_resolution.root_scope_id,
      metadata_table_count: this.tableColumnsByName.size,
      column_references: columnReferences,
      wildcard_expansions: wildcardExpansions
    };

    context.setPhysicalColumnResolution(result);
    this.#addDiagnostics(result, context);

    return result;
  }

  /**
   * メタデータをテーブル完全名ごとのMapへ変換する。
   *
   * Resolver本処理で毎回全行を走査しないよう、最初に索引化する。
   * 大量Viewを処理する場合、この前処理が探索コストを抑える。
   */
  #buildMetadataIndex() {
    this.tableColumnsByName = new Map();

    for (const [metadataIndex, rawColumn] of this.physicalColumns.entries()) {
      const column = this.#normalizeMetadataColumn(rawColumn, metadataIndex);
      const tableNames = this.#createTableLookupNames(column);

      for (const tableName of tableNames) {
        if (!this.tableColumnsByName.has(tableName)) {
          this.tableColumnsByName.set(tableName, []);
        }

        this.tableColumnsByName.get(tableName).push(column);
      }
    }

    /*
     * Wildcard展開結果を元テーブルの列順へ揃えるため、
     * ordinal_positionがある場合は昇順に並べる。
     */
    for (const columns of this.tableColumnsByName.values()) {
      columns.sort((left, right) => {
        const leftPosition = left.ordinal_position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.ordinal_position ?? Number.MAX_SAFE_INTEGER;

        return leftPosition - rightPosition;
      });
    }
  }

  #buildResolutionIndexes(context) {
    this.sourceById = new Map();

    for (const scope of context.source_resolution.scopes) {
      for (const source of scope.sources) {
        this.sourceById.set(source.source_id, source);
      }
    }

    this.outputColumnsByScopeId = new Map(
      context.output_column_resolution.scopes.map((scope) => {
        return [scope.scope_id, scope.output_columns];
      })
    );
  }

  #resolveColumnReference(reference, context) {
    if (reference.reference_type === "WILDCARD") {
      return this.#resolveWildcardReference(reference, context);
    }

    /*
     * GROUP BY / HAVING / QUALIFY / ORDER BYから参照されたSELECT出力
     * エイリアスは物理Sourceの列ではない。SELECT式側のLineageが既に
     * 依存列を保持しているため、ここでは正常解決として通過させる。
     */
    if (reference.resolution_status === "SELECT_ALIAS_RESOLVED") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "SELECT_ALIAS_RESOLVED",
        sourceId: null,
        physicalColumns: []
      });
    }

    if (reference.source_type === "PHYSICAL_TABLE" && reference.source_id) {
      return this.#resolveAgainstPhysicalSource(reference, reference.source_id);
    }

    if (
      reference.resolution_status === "AMBIGUOUS" &&
      reference.candidate_source_ids.length > 0
    ) {
      return this.#resolveAmbiguousReference(reference);
    }

    if (reference.source_type === "CTE" || reference.source_type === "SUBQUERY") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "DERIVED_SOURCE_RESOLVED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    if (reference.source_type === "UNNEST") {
      return this.#resolveCorrelatedUnnestReference(reference);
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: reference.resolution_status,
      sourceId: reference.source_id,
      physicalColumns: []
    });
  }


  /**
   * 相関UNNESTの別名参照を、元の物理STRUCT/ARRAYフィールドへ展開する。
   *
   * 例:
   *   LEFT JOIN UNNEST(customer.contacts) AS contact
   *   SELECT contact.contact_value
   *
   * UNNEST式の`customer.contacts`から親Sourceと配列フィールドを特定し、
   * `contact.contact_value`を`customer.contacts.contact_value`として
   * INFORMATION_SCHEMA.COLUMN_FIELD_PATHSへ照合する。
   *
   * 安全性のため、次の条件をすべて満たす場合だけ物理解決する。
   * - UNNEST式が単純な修飾識別子である。
   * - 先頭要素が同一scope内の既存Source aliasを指す。
   * - 親Sourceが物理テーブルである。
   * - 完全なfield_pathがメタデータに存在する。
   */
  #resolveCorrelatedUnnestReference(reference) {
    const unnestSource = this.sourceById.get(reference.source_id);
    const expressionParts = unnestSource?.expression?.node_type === "IDENTIFIER_EXPRESSION" &&
      Array.isArray(unnestSource.expression.parts)
      ? unnestSource.expression.parts.map((part) => this.#normalizeName(part))
      : [];

    if (expressionParts.length < 2) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_DEFERRED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    const parentAlias = expressionParts[0];
    const parentSource = Array.from(this.sourceById.values()).find((source) => {
      return source.scope_id === unnestSource.scope_id &&
        source.source_id !== unnestSource.source_id &&
        source.source_alias === parentAlias;
    });

    if (!parentSource || parentSource.source_type !== "PHYSICAL_TABLE") {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "UNNEST_DEFERRED",
        sourceId: reference.source_id,
        physicalColumns: []
      });
    }

    const nestedFieldPath = [
      ...expressionParts.slice(1),
      this.#normalizeName(reference.column_name)
    ].filter(Boolean).join(".");

    const matchingColumns = this.#getColumnsForSource(parentSource).filter((column) => {
      return column.field_path === nestedFieldPath;
    });

    if (matchingColumns.length === 0) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: this.#hasMetadataForSource(parentSource)
          ? "PHYSICAL_COLUMN_NOT_FOUND"
          : "PHYSICAL_METADATA_NOT_FOUND",
        sourceId: parentSource.source_id,
        physicalColumns: []
      });
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: "PHYSICAL_RESOLVED",
      sourceId: parentSource.source_id,
      physicalColumns: matchingColumns
    });
  }

  #resolveAgainstPhysicalSource(reference, sourceId) {
    const source = this.sourceById.get(sourceId);
    const matchingColumns = this.#findPhysicalColumns(
      source,
      reference.column_name
    );

    return this.#createPhysicalReference(reference, {
      physicalStatus: matchingColumns.length > 0
        ? "PHYSICAL_RESOLVED"
        : this.#hasMetadataForSource(source)
          ? "PHYSICAL_COLUMN_NOT_FOUND"
          : "PHYSICAL_METADATA_NOT_FOUND",
      sourceId,
      physicalColumns: matchingColumns
    });
  }

  /**
   * ColumnResolverでは物理スキーマが無いため、非修飾列が複数Sourceに
   * 存在し得る場合はAMBIGUOUSとしていた。
   *
   * ここでは各候補テーブルの実カラムを確認し、列を持つSourceが1件だけなら
   * 曖昧性を解消する。複数テーブルに同名列がある場合は曖昧なまま保持する。
   */
  #resolveAmbiguousReference(reference) {
    const matchedCandidates = [];

    for (const sourceId of reference.candidate_source_ids) {
      const source = this.sourceById.get(sourceId);

      if (!source || source.source_type !== "PHYSICAL_TABLE") {
        continue;
      }

      const columns = this.#findPhysicalColumns(source, reference.column_name);

      if (columns.length > 0) {
        matchedCandidates.push({ source, columns });
      }
    }

    if (matchedCandidates.length === 1) {
      return this.#createPhysicalReference(reference, {
        physicalStatus: "PHYSICAL_RESOLVED",
        sourceId: matchedCandidates[0].source.source_id,
        physicalColumns: matchedCandidates[0].columns
      });
    }

    return this.#createPhysicalReference(reference, {
      physicalStatus: matchedCandidates.length > 1
        ? "PHYSICAL_AMBIGUOUS"
        : "PHYSICAL_COLUMN_NOT_FOUND",
      sourceId: null,
      physicalColumns: matchedCandidates.flatMap((item) => item.columns),
      candidateSourceIds: matchedCandidates.map((item) => item.source.source_id)
    });
  }

  #resolveWildcardReference(reference, context) {
    const expandedColumns = this.#expandReferenceWildcard(reference, context);

    return this.#createPhysicalReference(reference, {
      physicalStatus: expandedColumns.length > 0
        ? "WILDCARD_EXPANDED"
        : "WILDCARD_NOT_EXPANDED",
      sourceId: reference.source_id,
      physicalColumns: expandedColumns
    });
  }

  /**
   * OutputColumnResolverがWILDCARD_PENDINGとして保持したSELECT項目を、
   * 具体的な出力列一覧へ展開する。
   *
   * 元のOutput Columnは消さず、展開結果を別配列へ返す。
   * これにより「元SQLではWildcardだった」という情報と、実際の公開列一覧の
   * 両方を保持できる。
   */
  #expandOutputWildcards(context) {
    const expansions = [];

    for (const outputColumn of context.output_column_resolution.output_columns) {
      if (outputColumn.output_status !== "WILDCARD_PENDING") {
        continue;
      }

      const reference = context.column_resolution.column_references.find((item) => {
        return item.scope_id === outputColumn.scope_id &&
          item.select_item_seq === outputColumn.output_column_seq &&
          item.reference_type === "WILDCARD";
      });

      if (!reference) {
        continue;
      }

      const expandedColumns = this.#expandReferenceWildcard(reference, context);
      const exclusions = new Set(
        (outputColumn.wildcard_exclusions || []).map((name) => this.#normalizeName(name))
      );
      const visibleColumns = expandedColumns.filter((physicalColumn) => {
        const outputName = physicalColumn.output_column_name ||
          physicalColumn.column_name ||
          physicalColumn.physical_column_name;
        return !exclusions.has(this.#normalizeName(outputName));
      });
      const replacements = outputColumn.wildcard_replacements || [];
      const replacementByName = new Map(replacements.map((item) => {
        return [this.#normalizeName(item.output_column_name), item];
      }));
      const wildcardBaseExpression = outputColumn.wildcard_qualifier
        ? `${outputColumn.wildcard_qualifier}.*`
        : "*";
      let wildcardExpression = exclusions.size > 0
        ? `${wildcardBaseExpression} EXCEPT(${[...exclusions].join(", ")})`
        : wildcardBaseExpression;
      if (replacements.length > 0) {
        const replacementText = replacements.map((item) => {
          return `${item.expression} AS ${item.output_column_name}`;
        }).join(", ");
        wildcardExpression += ` REPLACE(${replacementText})`;
      }

      for (const [expandedIndex, physicalColumn] of visibleColumns.entries()) {
        expansions.push({
          expanded_output_column_id: this.nextExpandedOutputColumnId++,
          source_output_column_id: outputColumn.output_column_id,
          scope_id: outputColumn.scope_id,
          select_item_seq: outputColumn.output_column_seq,
          expanded_column_seq: expandedIndex + 1,
          output_column_name: physicalColumn.output_column_name ||
            physicalColumn.column_name,
          source_id: physicalColumn.source_id,
          source_type: physicalColumn.source_type,
          source_name: physicalColumn.source_name,
          physical_table_name: physicalColumn.physical_table_name ?? null,
          physical_column_name: physicalColumn.physical_column_name ??
            physicalColumn.column_name ??
            physicalColumn.output_column_name ??
            null,
          field_path: physicalColumn.field_path ??
            physicalColumn.column_name ??
            physicalColumn.output_column_name ??
            null,
          data_type: physicalColumn.data_type ?? null,
          ordinal_position: physicalColumn.ordinal_position ?? null,
          wildcard_type: outputColumn.wildcard_type,
          wildcard_qualifier: outputColumn.wildcard_qualifier ?? null,
          wildcard_expression: wildcardExpression,
          wildcard_replacement: replacementByName.get(this.#normalizeName(
            physicalColumn.output_column_name || physicalColumn.column_name
          )) || null
        });
      }
    }

    return expansions;
  }

  #expandReferenceWildcard(reference, context) {
    const sourceIds = reference.source_id
      ? [reference.source_id]
      : reference.candidate_source_ids;
    const result = [];

    for (const sourceId of sourceIds) {
      const source = this.sourceById.get(sourceId);

      if (!source) {
        continue;
      }

      if (source.source_type === "PHYSICAL_TABLE") {
        for (const column of this.#getTopLevelColumns(source)) {
          result.push({
            ...column,
            source_id: source.source_id,
            source_type: source.source_type,
            source_name: source.source_name,
            output_column_name: column.column_name
          });
        }
        continue;
      }

      const childScopeId = source.cte_query_scope_id || source.subquery_scope_id;
      const expandedDerivedColumns = this.#expandDerivedScopeColumns(
        childScopeId,
        context,
        new Set()
      );

      for (const derivedColumn of expandedDerivedColumns) {
        result.push({
          ...derivedColumn,
          source_id: source.source_id,
          source_type: source.source_type,
          source_name: source.source_name
        });
      }
    }

    return result;
  }

  #expandDerivedScopeColumns(scopeId, context, visitingScopeIds) {
    if (scopeId === null || scopeId === undefined) {
      return [];
    }

    if (visitingScopeIds.has(scopeId)) {
      return [];
    }

    const nextVisiting = new Set(visitingScopeIds);
    nextVisiting.add(scopeId);
    const outputColumns = this.outputColumnsByScopeId.get(scopeId) || [];
    const result = [];

    for (const outputColumn of outputColumns) {
      if (outputColumn.output_status !== "WILDCARD_PENDING") {
        if (!outputColumn.output_column_name) {
          continue;
        }

        result.push({
          output_column_name: outputColumn.output_column_name,
          physical_table_name: null,
          physical_column_name: null,
          field_path: null,
          data_type: null,
          ordinal_position: outputColumn.output_column_seq
        });
        continue;
      }

      const wildcardReference = context.column_resolution.column_references.find((item) => {
        return item.scope_id === scopeId &&
          item.select_item_seq === outputColumn.output_column_seq &&
          item.reference_type === "WILDCARD";
      });

      if (!wildcardReference) {
        continue;
      }

      const sourceIds = wildcardReference.source_id
        ? [wildcardReference.source_id]
        : wildcardReference.candidate_source_ids;

      for (const sourceId of sourceIds) {
        const nestedSource = this.sourceById.get(sourceId);

        if (!nestedSource) {
          continue;
        }

        if (nestedSource.source_type === "PHYSICAL_TABLE") {
          for (const column of this.#getTopLevelColumns(nestedSource)) {
            result.push({
              output_column_name: column.column_name,
              physical_table_name: column.physical_table_name,
              physical_column_name: column.column_name,
              field_path: column.field_path,
              data_type: column.data_type,
              ordinal_position: column.ordinal_position
            });
          }
          continue;
        }

        const nestedScopeId = nestedSource.cte_query_scope_id ||
          nestedSource.subquery_scope_id;
        result.push(...this.#expandDerivedScopeColumns(
          nestedScopeId,
          context,
          nextVisiting
        ));
      }
    }

    const deduplicated = [];
    const seenNames = new Set();

    for (const column of result) {
      const name = this.#normalizeName(column.output_column_name);

      if (!name || seenNames.has(name)) {
        continue;
      }

      seenNames.add(name);
      deduplicated.push(column);
    }

    return deduplicated;
  }

  #findPhysicalColumns(source, columnName) {
    const tableColumns = this.#getColumnsForSource(source);
    const normalizedColumnName = this.#normalizeName(columnName);

    return tableColumns.filter((column) => {
      return column.column_name === normalizedColumnName ||
        column.field_path === normalizedColumnName;
    });
  }

  #getTopLevelColumns(source) {
    const seenNames = new Set();
    const result = [];

    for (const column of this.#getColumnsForSource(source)) {
      const isTopLevel = !column.field_path ||
        column.field_path === column.column_name ||
        !column.field_path.includes(".");

      if (!isTopLevel || seenNames.has(column.column_name)) {
        continue;
      }

      seenNames.add(column.column_name);
      result.push(column);
    }

    return result;
  }

  #getColumnsForSource(source) {
    if (!source?.source_name) {
      return [];
    }

    return this.tableColumnsByName.get(this.#normalizeName(source.source_name)) || [];
  }

  #hasMetadataForSource(source) {
    return this.#getColumnsForSource(source).length > 0;
  }

  #createPhysicalReference(reference, details) {
    const source = details.sourceId
      ? this.sourceById.get(details.sourceId)
      : null;

    return {
      physical_reference_id: this.nextPhysicalReferenceId++,
      column_reference_id: reference.column_reference_id,
      scope_id: reference.scope_id,
      clause_type: reference.clause_type,
      select_item_seq: reference.select_item_seq,
      reference_type: reference.reference_type,
      reference_name: reference.reference_name,
      column_name: reference.column_name,
      original_resolution_status: reference.resolution_status,
      physical_resolution_status: details.physicalStatus,
      source_id: source?.source_id ?? details.sourceId ?? null,
      source_type: source?.source_type ?? reference.source_type ?? null,
      source_name: source?.source_name ?? reference.source_name ?? null,
      source_alias: source?.source_alias ?? reference.source_alias ?? null,
      candidate_source_ids: details.candidateSourceIds ??
        reference.candidate_source_ids ?? [],
      physical_columns: details.physicalColumns.map((column) => ({
        physical_table_name: column.physical_table_name ?? null,
        physical_column_name: column.column_name ??
          column.physical_column_name ?? null,
        field_path: column.field_path ?? null,
        ordinal_position: column.ordinal_position ?? null,
        data_type: column.data_type ?? null,
        is_nullable: column.is_nullable ?? null
      })),
      start_token_seq: reference.start_token_seq,
      end_token_seq: reference.end_token_seq
    };
  }

  #normalizeMetadataColumn(rawColumn, metadataIndex) {
    if (!rawColumn || typeof rawColumn !== "object") {
      throw new TypeError(
        `PhysicalColumnResolver: metadata row ${metadataIndex + 1} is invalid.`
      );
    }

    const physicalTableName = this.#derivePhysicalTableName(rawColumn);
    const columnName = this.#normalizeName(rawColumn.column_name);

    if (!physicalTableName || !columnName) {
      throw new TypeError(
        `PhysicalColumnResolver: metadata row ${metadataIndex + 1} requires ` +
        "table_name and column_name."
      );
    }

    return {
      physical_table_name: physicalTableName,
      project_id: this.#normalizeName(rawColumn.project_id),
      dataset_id: this.#normalizeName(rawColumn.dataset_id),
      table_name: this.#normalizeName(rawColumn.table_name),
      column_name: columnName,
      field_path: this.#normalizeName(rawColumn.field_path || columnName),
      ordinal_position: rawColumn.ordinal_position ?? null,
      data_type: rawColumn.data_type ?? null,
      is_nullable: rawColumn.is_nullable ?? null
    };
  }

  #derivePhysicalTableName(rawColumn) {
    const tableName = this.#normalizeName(rawColumn.table_name);
    const projectId = this.#normalizeName(rawColumn.project_id);
    const datasetId = this.#normalizeName(rawColumn.dataset_id);

    if (tableName?.includes(".")) {
      return tableName;
    }

    return [projectId, datasetId, tableName].filter(Boolean).join(".");
  }

  /**
   * SQL側が`dataset.table`や`table`だけで記述される可能性を考慮し、
   * 完全名だけでなく末尾2要素・末尾1要素も索引へ登録する。
   */
  #createTableLookupNames(column) {
    const parts = column.physical_table_name.split(".");
    const names = new Set([column.physical_table_name]);

    if (parts.length >= 2) {
      names.add(parts.slice(-2).join("."));
    }

    names.add(parts[parts.length - 1]);
    return [...names];
  }

  #addDiagnostics(result, context) {
    for (const reference of result.column_references) {
      if (reference.physical_resolution_status === "PHYSICAL_METADATA_NOT_FOUND") {
        context.addDiagnostic(
          "WARNING",
          "PHYSICAL_METADATA_NOT_FOUND",
          `Physical metadata was not found for source "${reference.source_name}".`,
          {
            source_id: reference.source_id,
            source_name: reference.source_name,
            column_reference_id: reference.column_reference_id,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq
          }
        );
      }

      if (reference.physical_resolution_status === "PHYSICAL_COLUMN_NOT_FOUND") {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_NOT_FOUND",
          `Column "${reference.column_name}" was not found in the candidate ` +
          "physical table metadata.",
          {
            column_reference_id: reference.column_reference_id,
            column_name: reference.column_name,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq,
            candidate_source_ids: reference.candidate_source_ids
          }
        );
      }

      if (reference.physical_resolution_status === "PHYSICAL_AMBIGUOUS") {
        context.addDiagnostic(
          "ERROR",
          "PHYSICAL_COLUMN_AMBIGUOUS",
          `Column "${reference.column_name}" exists in multiple physical sources.`,
          {
            column_reference_id: reference.column_reference_id,
            column_name: reference.column_name,
            scope_id: reference.scope_id,
            start_token_seq: reference.start_token_seq,
            end_token_seq: reference.end_token_seq,
            candidate_source_ids: reference.candidate_source_ids
          }
        );
      }
    }
  }

  #validateContext(context) {
    if (!context || context.query_ast?.node_type !== "QUERY") {
      throw new TypeError("PhysicalColumnResolver.resolve: invalid context.");
    }

    const requiredProperties = [
      "source_resolution",
      "column_resolution",
      "output_column_resolution"
    ];

    for (const propertyName of requiredProperties) {
      if (!context[propertyName]) {
        throw new TypeError(
          `PhysicalColumnResolver.resolve: ${propertyName} is not set.`
        );
      }
    }
  }

  #normalizeName(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }

    return String(value).replace(/^`|`$/g, "").toUpperCase();
  }
}
