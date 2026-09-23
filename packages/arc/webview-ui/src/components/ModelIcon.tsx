import { createElement } from "react";
import { iconForModel, ICON_SVGS, DEFAULT_ICON } from "./model-icons";
type Props = {
  modelId?: string;
  size?: number;
  className?: string;
  title?: string;
};
export default function ModelIcon({ modelId, size = 14, className, title }: Props) {
  const name = modelId ? iconForModel(modelId) : DEFAULT_ICON;
  const svg = ICON_SVGS[name] ?? ICON_SVGS[DEFAULT_ICON];
  const stroke = svg[0] === 1;
  const paths = svg[2].map((p, i) =>
    createElement("path", { key: i, d: p[0], ...(p[1] ? { fillRule: p[1] } : {}), ...(p[2] ? { opacity: p[2] } : {}) }),
  );
  const content = svg[1]
    ? createElement("g", { key: "fit", transform: svg[1] }, paths)
    : paths;
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      className,
      title,
      fill: stroke ? "none" : "currentColor",
      stroke: stroke ? "currentColor" : undefined,
      strokeWidth: stroke ? 1.5 : undefined,
      strokeLinecap: stroke ? ("round" as const) : undefined,
      strokeLinejoin: stroke ? ("round" as const) : undefined,
      "aria-hidden": true,
    },
    content,
  );
}