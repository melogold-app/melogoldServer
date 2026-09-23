/**
 * Kysely plugins of the database layer.
 *
 * - {@link StripRowLocksPlugin} (SQLite only): removes `FOR UPDATE`/`FOR SHARE`/`NOWAIT`/`SKIP LOCKED` from every
 *   `SELECT`, including subqueries. SQLite has no row locks and would reject the syntax; exclusivity comes from
 *   `BEGIN IMMEDIATE` instead (API §9.4, §9.5). Queries keep one text for both dialects.
 * - {@link StatementCounterPlugin} (both dialects): counts statements of the current `db.read`/`db.write`/`db.run`, so
 *   that `lockUser` can check it is the first one.
 */
import { OperationNodeTransformer } from "kysely";
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  SelectModifier,
  SelectQueryNode,
  UnknownRow,
} from "kysely";
import { currentTxScope } from "./tx.ts";

const ROW_LOCK_MODIFIERS: ReadonlySet<SelectModifier> = new Set<SelectModifier>([
  "ForUpdate",
  "ForNoKeyUpdate",
  "ForShare",
  "ForKeyShare",
  "NoWait",
  "SkipLocked",
]);

class RowLockStripper extends OperationNodeTransformer {
  protected override transformSelectQuery(node: SelectQueryNode, queryId?: PluginTransformQueryArgs["queryId"]) {
    const transformed = super.transformSelectQuery(node, queryId);
    if (!transformed.endModifiers) return transformed;
    const endModifiers = transformed.endModifiers.filter(
      (modifier) => modifier.modifier === undefined || !ROW_LOCK_MODIFIERS.has(modifier.modifier),
    );
    return { ...transformed, endModifiers: endModifiers.length > 0 ? endModifiers : undefined };
  }
}

export class StripRowLocksPlugin implements KyselyPlugin {
  readonly #transformer = new RowLockStripper();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node, args.queryId);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

export class StatementCounterPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const scope = currentTxScope();
    if (scope) scope.statements += 1;
    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
