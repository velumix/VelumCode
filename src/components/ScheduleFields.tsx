import { useEffect, useState } from "react";
import { when } from "../bots";
import ChoiceMenu from "./ChoiceMenu";
import "./ScheduleFields.css";
const presets = [
  { id: "*/15 * * * *", label: "Every 15 minutes" },
  { id: "0 * * * *", label: "Every hour" },
  { id: "0 9 * * 1-5", label: "Weekdays at 9 AM" },
  { id: "0 9 * * *", label: "Every day at 9 AM" },
  { id: "custom", label: "Custom cron" },
];
export default function ScheduleFields({
  cron,
  timezone,
  automatic,
  onChange,
  preview,
  disabled = false,
}: {
  cron: string;
  timezone: string;
  automatic: boolean;
  onChange: (value: {
    cron: string;
    timezone: string;
    automatic: boolean;
  }) => void;
  preview?: (cron: string, timezone: string) => Promise<{ times: number[] }>;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(!presets.some((p) => p.id === cron));
  const [times, setTimes] = useState<number[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    setCustom(!presets.some((p) => p.id === cron));
  }, [cron]);
  useEffect(() => {
    if (!preview) return;
    let active = true;
    const timer = setTimeout(() => {
      void preview(cron, timezone)
        .then((r) => {
          if (active) {
            setTimes(r.times);
            setError("");
          }
        })
        .catch((e) => {
          if (active) {
            setTimes([]);
            setError(String(e));
          }
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cron, timezone, preview]);
  return (
    <div className="schedule-fields">
      <ChoiceMenu
        label="Schedule"
        value={custom ? "custom" : cron}
        choices={presets}
        disabled={disabled}
        onChange={(value) => {
          setCustom(value === "custom");
          if (value !== "custom")
            onChange({ cron: value, timezone, automatic });
        }}
      />
      {custom && (
        <label>
          Cron expression
          <input
            aria-label="Cron expression"
            value={cron}
            maxLength={100}
            disabled={disabled}
            onChange={(e) =>
              onChange({ cron: e.target.value, timezone, automatic })
            }
          />
          <small>Minute · hour · day · month · weekday</small>
        </label>
      )}
      <label>
        Timezone
        <input
          value={timezone}
          aria-label="Schedule timezone"
          list="schedule-timezones"
          disabled={disabled}
          maxLength={100}
          onChange={(e) =>
            onChange({ cron, timezone: e.target.value, automatic })
          }
        />
        <datalist id="schedule-timezones">
          <option value="UTC" />
          <option value="America/New_York" />
          <option value="America/Chicago" />
          <option value="America/Denver" />
          <option value="America/Los_Angeles" />
          <option value="Europe/London" />
          <option value="Europe/Paris" />
          <option value="Europe/Berlin" />
          <option value="Asia/Tokyo" />
          <option value="Asia/Shanghai" />
          <option value="Australia/Sydney" />
        </datalist>
      </label>
      <label className="bot-check">
        <input
          type="checkbox"
          checked={automatic}
          disabled={disabled}
          onChange={(e) =>
            onChange({ cron, timezone, automatic: e.target.checked })
          }
        />
        Run automatically on schedule
      </label>
      <p className="bot-help">
        {automatic
          ? "Runs while Velum is open or in the tray. Review and Done tasks stop running."
          : "The job is created, but each run waits for you to choose Run now."}
      </p>
      {times.length > 0 && (
        <p className="bot-help">Next runs: {times.map(when).join(" · ")}</p>
      )}
      {error && (
        <p role="alert" className="bot-error">
          {error}
        </p>
      )}
    </div>
  );
}
