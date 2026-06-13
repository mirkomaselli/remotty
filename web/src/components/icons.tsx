// Set di icone inline (stroke 2, 24x24) per non aggiungere dipendenze.

import type { ReactNode } from 'react';

interface IconProps {
  className?: string;
}

function svg(path: ReactNode, props: IconProps, filled = false) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className ?? 'h-5 w-5'}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const IconChevronLeft = (p: IconProps) => svg(<path d="M15 18l-6-6 6-6" />, p);
export const IconChevronRight = (p: IconProps) => svg(<path d="M9 18l6-6-6-6" />, p);
export const IconArrowDown = (p: IconProps) => svg(<path d="M12 5v14m7-7l-7 7-7-7" />, p);
export const IconPlus = (p: IconProps) => svg(<path d="M12 5v14M5 12h14" />, p);
export const IconX = (p: IconProps) => svg(<path d="M18 6L6 18M6 6l12 12" />, p);
export const IconKebab = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </>,
    p,
  );
export const IconTerminal = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M7 9l3 3-3 3M12.5 15H17" />
    </>,
    p,
  );
export const IconChat = (p: IconProps) =>
  svg(<path d="M21 12a8 8 0 01-8 8H4l2.3-2.9A8 8 0 1121 12z" />, p);
export const IconFolder = (p: IconProps) =>
  svg(<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />, p);
export const IconHome = (p: IconProps) =>
  svg(<path d="M3 11l9-8 9 8v8a2 2 0 01-2 2h-4v-6h-6v6H5a2 2 0 01-2-2v-8z" />, p);
export const IconWrench = (p: IconProps) =>
  svg(
    <path d="M14.7 6.3a4.5 4.5 0 005.8 5.8L15 17.6a2.1 2.1 0 01-3-3l5.5-5.5a4.5 4.5 0 00-5.8-5.8l2 2-3 3-2-2a4.5 4.5 0 005.8 5.8" />,
    p,
  );
export const IconSend = (p: IconProps) =>
  svg(<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />, p);
export const IconStop = (p: IconProps) =>
  svg(<rect x="6" y="6" width="12" height="12" rx="2" />, p, true);
export const IconTrash = (p: IconProps) =>
  svg(
    <>
      <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </>,
    p,
  );
export const IconPaperclip = (p: IconProps) =>
  svg(
    <path d="M21.4 11.6l-8.9 8.9a6 6 0 01-8.5-8.5l9.6-9.6a4 4 0 015.7 5.7l-9.6 9.6a2 2 0 01-2.8-2.8l8.9-8.9" />,
    p,
  );
export const IconFile = (p: IconProps) =>
  svg(
    <>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v5h5" />
    </>,
    p,
  );
export const IconBell = (p: IconProps) =>
  svg(
    <>
      <path d="M18 8a6 6 0 00-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>,
    p,
  );
export const IconGit = (p: IconProps) =>
  svg(
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 8.2v7.6M15.8 9.6c-3 .8-6.4 1.4-7.8 4.5" />
    </>,
    p,
  );
export const IconCheck = (p: IconProps) => svg(<path d="M5 13l4 4L19 7" />, p);
