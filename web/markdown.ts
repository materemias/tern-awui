import { marked } from "marked";
import DOMPurify from "dompurify";

// Raw HTML in agent output is shown as text, never parsed. Transcripts carry text from
// web pages and mail, so the rendered HTML is also sanitized: a `javascript:` link
// tapped here would run with this page's shell-control rights.
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    // omp's figures: ```svg drawn inline (the sanitizer drops scripts and handlers), ```mermaid
    // left as its source, which <Markdown> swaps for the diagram once the mermaid chunk loads.
    code: ({ text, lang }) => {
      if (lang === "svg") return `<div class="figure">${text}</div>`;
      if (lang === "mermaid") return `<div class="figure mermaid-src"><pre>${escapeHtml(text)}</pre></div>`;
      // Other fences: a plain code block whose language shows in its corner.
      const name = /^[\w+#.-]{1,16}$/.test(lang ?? "") ? ` data-lang="${lang}"` : "";
      return `<pre${name}><code>${escapeHtml(text)}</code></pre>\n`;
    },
  },
});

/**
 * DOMPurify's default URI check minus the risky schemes: http(s)/mailto links, and values with no
 * scheme at all (relative links, and plain attribute values such as an svg's `x="10"`, which a
 * schemes-only pattern would strip). `javascript:`/`data:` links would run with shell-control rights.
 */
const SAFE_URI = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

// DOMPurify's default instance binds to the window present when the module loads. Bind to the
// current document's own window instead: test files each register their own DOM, and the `window`
// global can lag behind `document`; a purifier bound to another window strips every element.
let purifier = DOMPurify;
let purifierDocument: Document | undefined;
function purify(): typeof DOMPurify {
  if (purifierDocument !== document) {
    purifier = DOMPurify(document.defaultView ?? window);
    purifierDocument = document;
  }
  return purifier;
}

/** Agent and note markdown as safe HTML. */
export function renderMarkdown(text: string, imageSources?: Record<string, string>): string {
  const html = marked.parse(text, {
    async: false,
    walkTokens: imageSources ? (token) => {
      if (token.type === "image" && Object.hasOwn(imageSources, token.href)) token.href = imageSources[token.href];
    } : undefined,
  });
  return purify().sanitize(html, { ALLOWED_URI_REGEXP: SAFE_URI });
}

/** Tern's colored capture: <pre> and styled <span>s; scripts and links are stripped. */
export function screenHtml(html: string): string {
  return purify().sanitize(html, { ALLOWED_TAGS: ["pre", "span", "b", "i", "u"], ALLOWED_ATTR: ["style"] });
}
