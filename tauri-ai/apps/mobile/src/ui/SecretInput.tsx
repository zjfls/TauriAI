import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { clsx } from "../lib/clsx";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function SecretInput({ className, ...rest }: Props) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  const title = visible ? "隐藏密钥" : "显示密钥";

  return (
    <div className="relative">
      <input
        className={clsx(
          "h-10 w-full rounded-md bg-white/5 border border-white/10 px-3 text-[16px] leading-5 outline-none focus:border-indigo-400 pr-10",
          className,
        )}
        type={visible ? "text" : "password"}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10"
        title={title}
        aria-label={title}
      >
        <Icon size={16} />
      </button>
    </div>
  );
}
