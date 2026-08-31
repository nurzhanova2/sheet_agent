declare const idBrand: unique symbol;

export type BrandedId<TName extends string> = string & { readonly [idBrand]: TName };
export type ConversationId = BrandedId<"ConversationId">;
export type RunId = BrandedId<"RunId">;
export type ToolCallId = BrandedId<"ToolCallId">;
export type ChangeSetId = BrandedId<"ChangeSetId">;
export type EventId = BrandedId<"EventId">;
export type OperationId = BrandedId<"OperationId">;

export interface IdGenerator {
  create<TName extends string>(namespace: TName): BrandedId<TName>;
}
