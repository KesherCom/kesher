import { useId, type ReactNode } from "react";

/** A titled block inside a settings page; groups are divided by a line. */
export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="k-settings-group">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/**
 * One on/off setting: a switch, its name and one line saying what it does.
 * The hint is the description, not part of the name.
 */
export function SettingSwitch({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className={`k-setting ${disabled ? "disabled" : ""}`}>
      <input
        id={id}
        type="checkbox"
        className="k-switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <small id={`${id}-hint`} className="k-setting-hint">
          {hint}
        </small>
      ) : null}
    </div>
  );
}
