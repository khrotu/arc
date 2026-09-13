import { createElement, type SVGProps } from "react";
type IconNode = [string, Record<string, string>][];
function Icon({ iconNode, size = 24, strokeWidth = 2, className = "", color, ...props }: {
  iconNode: IconNode;
  size?: number;
  strokeWidth?: number;
  className?: string;
  color?: string;
} & Omit<SVGProps<SVGSVGElement>, "ref">) {
  return createElement("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color ?? "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    ...props,
  }, iconNode.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs })));
}
type IconProps = { size?: number; strokeWidth?: number; className?: string; color?: string; style?: React.CSSProperties };
const mk = (node: IconNode) => (p: IconProps) => createElement(Icon, { iconNode: node, ...p });
export const AlertTriangle =  mk([
  ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }],
  ["path", { d: "M12 9v4" }],
  ["path", { d: "M12 17h.01" }],
]);
export const ArrowLeft =  mk([
  ["path", { d: "m12 19-7-7 7-7" }],
  ["path", { d: "M19 12H5" }],
]);
export const ArrowRight =  mk([
  ["path", { d: "M5 12h14" }],
  ["path", { d: "m12 5 7 7-7 7" }],
]);
export const ArrowUp =  mk([
  ["path", { d: "m5 12 7-7 7 7" }],
  ["path", { d: "M12 19V5" }],
]);
export const Bot =  mk([
  ["path", { d: "M12 8V4H8" }],
  ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
  ["path", { d: "M2 14h2" }],
  ["path", { d: "M20 14h2" }],
  ["path", { d: "M15 13v2" }],
  ["path", { d: "M9 13v2" }],
]);
export const BugPlay =  mk([
  ["path", { d: "M12.765 21.522a.5.5 0 0 1-.765-.424v-8.196a.5.5 0 0 1 .765-.424l5.878 3.674a1 1 0 0 1 0 1.696z" }],
  ["path", { d: "M14.12 3.88 16 2" }],
  ["path", { d: "M18 11a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v3a6.1 6.1 0 0 0 2 4.5" }],
  ["path", { d: "M20.97 5c0 2.1-1.6 3.8-3.5 4" }],
  ["path", { d: "M3 21c0-2.1 1.7-3.9 3.8-4" }],
  ["path", { d: "M6 13H2" }],
  ["path", { d: "M6.53 9C4.6 8.8 3 7.1 3 5" }],
  ["path", { d: "m8 2 1.88 1.88" }],
  ["path", { d: "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" }],
]);
export const Check =  mk([
  ["path", { d: "M20 6 9 17l-5-5" }],
]);
export const ChevronDown =  mk([
  ["path", { d: "m6 9 6 6 6-6" }],
]);
export const ChevronRight =  mk([
  ["path", { d: "m9 18 6-6-6-6" }],
]);
export const Circle =  mk([
  ["circle", { cx: "12", cy: "12", r: "10" }],
]);
export const CircleDot =  mk([
  ["circle", { cx: "12", cy: "12", r: "10" }],
  ["circle", { cx: "12", cy: "12", r: "1" }],
]);
export const CornerDownLeft =  mk([
  ["polyline", { points: "9 10 4 15 9 20" }],
  ["path", { d: "M20 4v7a4 4 0 0 1-4 4H4" }],
]);
export const ExternalLink =  mk([
  ["path", { d: "M15 3h6v6" }],
  ["path", { d: "M10 14 21 3" }],
  ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
]);
export const FileSearch =  mk([
  ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }],
  ["path", { d: "M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3" }],
  ["path", { d: "m9 18-1.5-1.5" }],
  ["circle", { cx: "5", cy: "14", r: "3" }],
]);
export const FoldVertical =  mk([
  ["path", { d: "M12 22v-6" }],
  ["path", { d: "M12 8V2" }],
  ["path", { d: "M4 12H2" }],
  ["path", { d: "M10 12H8" }],
  ["path", { d: "M16 12h-2" }],
  ["path", { d: "M22 12h-2" }],
  ["path", { d: "m15 19-3-3-3 3" }],
  ["path", { d: "m15 5-3 3-3-3" }],
]);
export const HelpCircle =  mk([
  ["circle", { cx: "12", cy: "12", r: "10" }],
  ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }],
  ["path", { d: "M12 17h.01" }],
]);
export const History =  mk([
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }],
  ["path", { d: "M3 3v5h5" }],
  ["path", { d: "M12 7v5l4 2" }],
]);
export const Info =  mk([
  ["circle", { cx: "12", cy: "12", r: "10" }],
  ["path", { d: "M12 16v-4" }],
  ["path", { d: "M12 8h.01" }],
]);
export const Layers =  mk([
  ["path", { d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" }],
  ["path", { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" }],
  ["path", { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" }],
]);
export const ListChecks =  mk([
  ["path", { d: "m3 17 2 2 4-4" }],
  ["path", { d: "m3 7 2 2 4-4" }],
  ["path", { d: "M13 6h8" }],
  ["path", { d: "M13 12h8" }],
  ["path", { d: "M13 18h8" }],
]);
export const Maximize2 =  mk([
  ["polyline", { points: "15 3 21 3 21 9" }],
  ["polyline", { points: "9 21 3 21 3 15" }],
  ["line", { x1: "21", x2: "14", y1: "3", y2: "10" }],
  ["line", { x1: "3", x2: "10", y1: "21", y2: "14" }],
]);
export const PanelLeft =  mk([
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M9 3v18" }],
]);
export const PanelLeftClose =  mk([
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M9 3v18" }],
  ["path", { d: "m16 15-3-3 3-3" }],
]);
export const Paperclip =  mk([
  ["path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" }],
]);
export const Pencil =  mk([
  ["path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }],
  ["path", { d: "m15 5 4 4" }],
]);
export const Play =  mk([
  ["polygon", { points: "6 3 20 12 6 21 6 3" }],
]);
export const Plug =  mk([
  ["path", { d: "M12 22v-5" }],
  ["path", { d: "M9 8V2" }],
  ["path", { d: "M15 8V2" }],
  ["path", { d: "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" }],
]);
export const Plus =  mk([
  ["path", { d: "M5 12h14" }],
  ["path", { d: "M12 5v14" }],
]);
export const RefreshCw =  mk([
  ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
  ["path", { d: "M21 3v5h-5" }],
  ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
  ["path", { d: "M8 16H3v5" }],
]);
export const Search =  mk([
  ["circle", { cx: "11", cy: "11", r: "8" }],
  ["path", { d: "m21 21-4.3-4.3" }],
]);
export const SearchCheck =  mk([
  ["path", { d: "m8 11 2 2 4-4" }],
  ["circle", { cx: "11", cy: "11", r: "8" }],
  ["path", { d: "m21 21-4.3-4.3" }],
]);
export const Settings =  mk([
  ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
  ["circle", { cx: "12", cy: "12", r: "3" }],
]);
export const ShieldCheck =  mk([
  ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
  ["path", { d: "m9 12 2 2 4-4" }],
]);
export const ShieldOff =  mk([
  ["path", { d: "m2 2 20 20" }],
  ["path", { d: "M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71" }],
  ["path", { d: "M9.309 3.652A12.252 12.252 0 0 0 11.24 2.28a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v7a9.784 9.784 0 0 1-.08 1.264" }],
]);
export const ShieldHalf =  mk([
  ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
  ["path", { d: "M12 2.19v19.63" }],
]);
export const Sparkles =  mk([
  ["path", { d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" }],
  ["path", { d: "M20 3v4" }],
  ["path", { d: "M22 5h-4" }],
  ["path", { d: "M4 17v2" }],
  ["path", { d: "M5 18H3" }],
]);
export const Square =  mk([
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
]);
export const StopCircle =  mk([
  ["circle", { cx: "12", cy: "12", r: "10" }],
  ["rect", { width: "6", height: "6", x: "9", y: "9" }],
]);
export const Terminal =  mk([
  ["polyline", { points: "4 17 10 11 4 5" }],
  ["line", { x1: "12", x2: "20", y1: "19", y2: "19" }],
]);
export const Trash2 =  mk([
  ["path", { d: "M3 6h18" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17" }],
]);
export const Undo2 =  mk([
  ["path", { d: "M9 14 4 9l5-5" }],
  ["path", { d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" }],
]);
export const Wrench =  mk([
  ["path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }],
]);
export const X =  mk([
  ["path", { d: "M18 6 6 18" }],
  ["path", { d: "m6 6 12 12" }],
]);