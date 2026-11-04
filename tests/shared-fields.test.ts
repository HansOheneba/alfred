import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Field, inputClass } from "@/app/components/ui";
import { Select } from "@/app/components/select";
import { AuthForm } from "@/app/auth-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

const field = (props: Parameters<typeof Field>[0]) => createElement(Field, props);
const renderField = (props: Parameters<typeof Field>[0]) => renderToStaticMarkup(field(props));

describe("shared accessible native fields", () => {
  it("names a custom picker from its visible Field label and connects hint and error text", () => {
    const markup = renderField({ label: "Account", hint: "Choose a saved account", error: "Choose an available account", children: createElement(Select, { value: "", required: true, name: "account" }, createElement("option", { value: "wallet" }, "Sample wallet")) });
    const labelId = /<span id="([^"]+)" class="alfred-field-label"/.exec(markup)![1];
    const hintId = /<span id="([^"]+)" class="alfred-field-hint"/.exec(markup)![1];
    const errorId = /<span id="([^"]+)" class="alfred-field-hint alfred-field-hint--error"/.exec(markup)![1];
    const trigger = /<button[^>]*role="combobox"[^>]*>/.exec(markup)![0];
    expect(trigger).toContain(`aria-labelledby="${labelId}"`);
    expect(trigger).toContain(`aria-describedby="${hintId} ${errorId}"`);
    expect(trigger).toContain('aria-invalid="true"');
    expect(markup).toContain('name="account"');
  });

  it("associates the visible label and hint without dropping existing descriptions or native constraints", () => {
    const markup = renderField({ label: "Amount", hint: "Before fees", children: createElement("input", { className: inputClass, name: "amount", inputMode: "decimal", required: true, defaultValue: "12.30", "aria-describedby": "currency-help" }) });
    const hintId = /<span id="([^"]+)" class="alfred-field-hint"/.exec(markup)![1];
    expect(markup).toContain("alfred-field-label\">Amount</span>");
    expect(markup).toContain(`aria-describedby="currency-help ${hintId}"`);
    expect(markup).toContain('name="amount"');
    expect(markup).toContain('inputMode="decimal"');
    expect(markup).toContain('required=""');
    expect(markup).toContain('value="12.30"');
  });

  it("connects a supplied error to its native control and preserves a separate hint", () => {
    const markup = renderField({ label: "Email", hint: "Your account address", error: "Enter a valid email", children: createElement("input", { type: "email", "aria-describedby": "server-feedback", "aria-invalid": false }) });
    const hintId = /<span id="([^"]+)" class="alfred-field-hint"/.exec(markup)![1];
    const errorId = /<span id="([^"]+)" class="alfred-field-hint alfred-field-hint--error"/.exec(markup)![1];
    expect(markup).toContain(`aria-describedby="server-feedback ${hintId} ${errorId}"`);
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain(`aria-errormessage="${errorId}"`);
    expect(markup).toContain("Enter a valid email");
  });

  it("keeps existing invalid and error references when no Field error is supplied", () => {
    const markup = renderField({ label: "Name", children: createElement("input", { "aria-invalid": true, "aria-errormessage": "saved-name-error", disabled: true }) });
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-errormessage="saved-name-error"');
    expect(markup).toContain('disabled=""');
  });

  it("gives separate controls unique hint IDs and leaves custom children intact", () => {
    const CustomControl = ({ disabled }: { disabled: boolean }) => createElement("input", { disabled, "data-custom-control": "preserved" });
    const markup = renderToStaticMarkup(createElement("form", null,
      field({ label: "Start", hint: "First day", children: createElement("input", { type: "date", readOnly: true, defaultValue: "2026-11-04" }) }),
      field({ label: "End", hint: "Last day", children: createElement("input", { type: "month" }) }),
      field({ label: "Custom", hint: "Custom owner", children: createElement(CustomControl, { disabled: true }) }),
    ));
    const ids = [...markup.matchAll(/<span id="([^"]+)" class="alfred-field-hint"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(3);
    expect(markup).toContain('type="date"');
    expect(markup).toContain('readOnly=""');
    expect(markup).toContain('type="month"');
    expect(markup).toMatch(/<input disabled="" data-custom-control="preserved"\/>/);
  });

  it("retains native select, file, textarea and checkbox behavior", () => {
    const markup = renderToStaticMarkup(createElement("form", null,
      field({ label: "Account", hint: "Choose one", children: createElement("select", { className: inputClass, name: "account", defaultValue: "wallet", required: true }, createElement("option", { value: "wallet" }, "Wallet")) }),
      createElement("input", { type: "file", hidden: true, accept: "image/png", name: "attachment" }),
      createElement("textarea", { className: inputClass, name: "note", rows: 4, maxLength: 200, defaultValue: "Saved note" }),
      createElement("input", { type: "checkbox", name: "included", defaultChecked: true, disabled: true }),
    ));
    expect(markup).toContain('name="account" required=""');
    expect(markup).toContain('value="wallet" selected=""');
    expect(markup).toContain('type="file" hidden="" accept="image/png"');
    expect(markup).toContain('rows="4" maxLength="200">Saved note</textarea>');
    expect(markup).toContain('type="checkbox" disabled="" name="included" checked=""');
  });

  it("uses the shared field outside the signed-in app without changing authentication constraints", () => {
    const markup = renderToStaticMarkup(createElement(AuthForm, { mode: "sign-in" }));
    expect(markup).toContain('class="alfred-field"');
    expect(markup).toContain('class="alfred-input"');
    expect(markup).toContain('type="email"');
    expect(markup).toContain('autoComplete="email"');
    expect(markup).toContain('required=""');
    expect(markup).toContain("Send code");
  });
});

describe("field assets and compound-control boundaries", () => {
  it("uses the supplied Figma assets at their native geometry and leaves hidden attachments and Chat out of ordinary geometry", () => {
    const stylesheet = readFileSync(new URL("../app/components/fields.css", import.meta.url), "utf8");
    for (const [name, size] of [["input-alert", 16], ["input-check", 14], ["input-chevron-down", 20]] as const) {
      const asset = readFileSync(new URL(`../public/icons/${name}.svg`, import.meta.url), "utf8");
      expect(asset).toContain(`width="${size}" height="${size}"`);
      expect(stylesheet).toContain(`/icons/${name}.svg`);
    }
    expect(stylesheet).toContain('[hidden], [type="hidden"]');
    expect(stylesheet).toContain('.alfred-production-chat-composer textarea, #alfred-chat-message, .alfred-ui-insightInput input');
    expect(stylesheet).not.toContain("!important");
    expect(stylesheet).toContain("font-size: 16px");
    expect(stylesheet).toContain("forced-colors: active");
  });
});
