// Fixtures HTML dos testes carregadas como texto (`?raw` do Vite/Vitest).
declare module '*.html?raw' {
  const content: string;
  export default content;
}
