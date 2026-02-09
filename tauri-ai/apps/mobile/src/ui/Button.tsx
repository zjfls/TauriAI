import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import { clsx } from "../lib/clsx";

type Props = PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger";
    size?: "sm" | "md";
  }
>;

export function Button({
  className,
  variant = "primary",
  size = "md",
  children,
  ...rest
}: Props) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-2 text-xs" : "h-10 px-3 text-sm",
        variant === "primary" && "bg-indigo-500 hover:bg-indigo-400 text-white",
        variant === "ghost" && "bg-white/5 hover:bg-white/10 text-white",
        variant === "danger" && "bg-red-500/80 hover:bg-red-500 text-white",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

