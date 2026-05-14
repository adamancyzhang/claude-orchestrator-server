export interface IEventBus<T extends { type: string }> {
  emit(event: T): void;
  on<K extends T["type"]>(
    type: K,
    cb: (event: Extract<T, { type: K }>) => void,
  ): () => void;
  onAny(cb: (event: T) => void): () => void;
}
