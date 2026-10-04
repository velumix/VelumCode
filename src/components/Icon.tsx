import type { CSSProperties } from "react";
import velumMark from "../assets/velum-mark.png";

export type IconName = "board" | "search" | "plus" | "chat" | "folder" | "code" | "branch" | "terminal" | "arrow" | "down" | "chevron" | "reset" | "command" | "check" | "copy" | "close" | "shield" | "bell" | "phone" | "memory" | "settings" | "edit" | "bug" | "sparkles";

const paths: Record<IconName, string> = {
  bug: "M19 13h-4m4-4h-4M5 13h4M5 9h4m6 1v4a4 4 0 0 1-8 0v-4a4 4 0 0 1 8 0Zm-6-4 1.5 2h5L17 6",
  sparkles: "m12 3 1.9 4.1L18 9l-4.1 1.9L12 15l-1.9-4.1L6 9l4.1-1.9L12 3Z",
  chevron: "m6 9 6 6 6-6",
  edit: "m16 3 5 5L9 20l-6 1 1-6L16 3Zm-2 2 5 5",
  board: "M3 4h18v16H3V4Zm6 0v16m6-16v16M5 8h2m4 0h2m4 0h2M5 12h2m6 0h-2",
  memory: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm16 0h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3V4Z",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  phone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm2 0v3h6V2M11 18h2",
  search: "M21 21l-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z",
  plus: "M12 5v14M5 12h14",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 2h18",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
  branch: "M6 3v12M18 9a9 9 0 0 1-9 9M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  terminal: "m5 7 5 5-5 5m8 0h6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  down: "M12 4v16m-6-6 6 6 6-6",
  reset: "M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7",
  command: "M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z",
  check: "m5 12 4 4L19 6",
  copy: "M9 9h11v12H9V9ZM5 15H3V3h12v2",
  close: "m6 6 12 12M18 6 6 18",
  shield: "m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Zm-3 9 2 2 4-4",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12a2 2 0 0 0 4 0",
};

export default function Icon({ name, size = 18, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function VelumMark({ size = 40 }: { size?: number }) {
  return <img className="velum-mark" src={velumMark} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
