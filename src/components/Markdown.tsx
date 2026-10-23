import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./Markdown.css";

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Abre el enlace con el navegador del sistema; la app nunca navega por su cuenta. Fuera de Tauri no hace nada. */
function openExternal(href: string) {
  void Promise.resolve()
    .then(() => openUrl(href))
    .catch(() => {});
}

const components: Components = {
  a({ href, children }) {
    if (!href || !SAFE_LINK.test(href)) return <span>{children}</span>;
    return (
      <a
        href={href}
        title={href}
        rel="noreferrer noopener"
        onClick={(e) => {
          e.preventDefault();
          openExternal(href);
        }}
      >
        {children}
      </a>
    );
  },
  // Sin imágenes remotas: solo el texto alternativo.
  img({ alt }) {
    return <span className="md-img">[imagen{alt ? `: ${alt}` : ""}]</span>;
  },
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

/** Texto Markdown (GFM) sin HTML crudo: `skipHtml` descarta las etiquetas y `urlTransform` quita `javascript:`. */
export default function Markdown({ text, label }: { text: string; label?: string }) {
  return (
    <div className="md" role={label ? "region" : undefined} aria-label={label}>
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
