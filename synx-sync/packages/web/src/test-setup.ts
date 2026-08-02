import '@testing-library/jest-dom/vitest';

// jsdom 在 Vitest 下不保证提供 localStorage，这里注入内存实现
const store = new Map<string, string>();
const storageMock: Storage = {
  get length() { return store.size; },
  clear: () => store.clear(),
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => { store.delete(key); },
  setItem: (key, value) => { store.set(key, String(value)); },
};
Object.defineProperty(window, 'localStorage', { value: storageMock, configurable: true });
