import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export interface AboutPanelContent {
  name: string;
  version: string;
  builtAt: string;
  icon: string;
  styleSha256: string;
}

export const ABOUT_PANEL_CSS = `body::before{content:"";position:fixed;inset:0 0 auto;height:34px;-webkit-app-region:drag}button,a,input,summary{-webkit-app-region:no-drag}:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:light-dark(#25242b,#f2f1f6);background:light-dark(#faf9fc,#25242b)}*{box-sizing:border-box}body{margin:0;padding:54px 24px 32px;text-align:center;user-select:text}img{width:76px;height:76px;display:block;margin:0 auto 18px}h1{font-size:23px;line-height:1.2;letter-spacing:-.45px;font-weight:650;margin:0 0 14px}p{font-size:13px;line-height:1.5;margin:4px 0;color:light-dark(#6b6875,#bbb7c7)}.date{font-size:12px;margin-top:10px}`;

export function aboutPanelDocument(input: AboutPanelContent): string {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(input.icon)) {
    throw new Error("DESKTOP_ABOUT_ICON_INVALID");
  }
  const date = new Date(input.builtAt);
  if (!Number.isFinite(date.getTime()))
    throw new Error("DESKTOP_ABOUT_DATE_INVALID");
  const released = date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  const hash = input.styleSha256;
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      h(
        "html",
        { lang: "en" },
        h(
          "head",
          null,
          h("meta", { charSet: "utf-8" }),
          h("meta", {
            name: "viewport",
            content: "width=device-width,initial-scale=1",
          }),
          h("meta", {
            httpEquiv: "Content-Security-Policy",
            content: `default-src 'none'; img-src data:; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`,
          }),
          h("title", null, `About ${input.name}`),
          h("style", null, ABOUT_PANEL_CSS),
        ),
        h(
          "body",
          null,
          h(
            "main",
            null,
            h("img", { src: input.icon, alt: "" }),
            h("h1", null, input.name),
            h("p", null, `Version ${input.version}`),
            h("p", { className: "date" }, released),
          ),
        ),
      ),
    )
  );
}
