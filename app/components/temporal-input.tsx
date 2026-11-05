"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

type TemporalInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  type: "date" | "month" | "time" | "datetime-local" | "week";
};

/** Keep native pickers while keeping iOS date/time padding outside the input. */
export const TemporalInput = forwardRef<HTMLInputElement, TemporalInputProps>(function TemporalInput(
  { className = "", style, ...props }, ref,
) {
  return <span className={`alfred-input alfred-temporal ${className}`} style={style}>
    <input {...props} ref={ref} className="alfred-temporal-native" />
  </span>;
});
