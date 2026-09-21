// Globais do Tampermonkey usadas pelo userscript (declarações mínimas).
declare const GM_getValue: (key: string, fallback?: unknown) => unknown;
declare const GM_setValue: (key: string, value: unknown) => void;
declare const GM_deleteValue: (key: string) => void;
