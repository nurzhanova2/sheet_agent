import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, vi } from "vitest";

vi.mock("@fluentui/react-components", () => ({
  Button: ({ icon, children, ...props }: Record<string, unknown>) =>
    createElement("button", props, icon as React.ReactNode, children as React.ReactNode),
  Caption1: ({ children, ...props }: Record<string, unknown>) =>
    createElement("span", props, children as React.ReactNode),
  FluentProvider: ({ children, ...props }: Record<string, unknown>) => {
    const { theme, ...domProps } = props;
    void theme;
    return createElement("div", domProps, children as React.ReactNode);
  },
  Text: ({ as = "span", children, ...props }: Record<string, unknown>) =>
    createElement(as as string, props, children as React.ReactNode),
  Textarea: ({ onChange, ...props }: Record<string, unknown>) =>
    createElement("textarea", {
      ...props,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        (onChange as (event: React.ChangeEvent<HTMLTextAreaElement>, data: { value: string }) => void)(event, {
          value: event.target.value,
        }),
    }),
  webDarkTheme: {},
  webLightTheme: {},
}));

vi.mock("@fluentui/react-icons", () => ({
  ArrowClockwise20Regular: () => createElement("span", { "aria-hidden": true }),
  Bot24Regular: () => createElement("span", { "aria-hidden": true }),
  Send24Regular: () => createElement("span", { "aria-hidden": true }),
  Settings20Regular: () => createElement("span", { "aria-hidden": true }),
}));

afterEach(cleanup);

Object.defineProperty(globalThis, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
