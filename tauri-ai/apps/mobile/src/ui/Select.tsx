import type { SelectHTMLAttributes } from "react";
import { clsx } from "../lib/clsx";

type Props = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, ...rest }: Props) {
  return (
    <select
      className={clsx(
        // 同 Input：避免 iOS 聚焦时自动缩放造成的“变大/可横向拖动”体验。
        "h-10 w-full max-w-full rounded-md bg-white/5 border border-white/10 px-3 text-[16px] leading-5 outline-none focus:border-indigo-400",
        className,
      )}
      {...rest}
    />
  );
}
