import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type SecretInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export const SecretInput: React.FC<SecretInputProps> = ({ className, ...props }) => {
  const [visible, setVisible] = useState(false);

  const inputClassName = [className, 'pr-10'].filter(Boolean).join(' ');
  const Icon = visible ? EyeOff : Eye;
  const title = visible ? '隐藏密钥' : '显示密钥';

  return (
    <div className="relative">
      <input {...props} type={visible ? 'text' : 'password'} className={inputClassName} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
        title={title}
        aria-label={title}
      >
        <Icon size={16} />
      </button>
    </div>
  );
};

