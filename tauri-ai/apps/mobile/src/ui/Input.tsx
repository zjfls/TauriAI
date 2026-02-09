import type { InputHTMLAttributes } from "react";
import { clsx } from "../lib/clsx";

type Props = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: Props) {
  return (
    <input
      className={clsx(
        // iOS WebView：输入框 font-size < 16px 时聚焦会自动“放大/缩放”页面（像是输入框变大）。
        // 这里统一用 16px，避免手机端聚焦时布局跳动。
        "h-10 w-full rounded-md bg-white/5 border border-white/10 px-3 text-[16px] leading-5 outline-none focus:border-indigo-400",
        className,
      )}
      {...rest}
    />
  );
}
