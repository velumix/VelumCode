import type { BotIdentity } from "../bots";
import BotEnergyOrb, { type OrbStatus } from "./BotEnergyOrb";
import "./BotAvatar.css";

export type { OrbStatus };

export default function BotAvatar({
  bot,
  size = 32,
  status = "idle",
}: {
  bot: Pick<BotIdentity, "name" | "avatar" | "color">;
  size?: number;
  status?: OrbStatus;
}) {
  return (
    <span
      className={`bot-avatar${bot.avatar ? " has-picture" : " has-orb"}`}
      style={{
        width: size,
        height: size,
        background: bot.avatar ? bot.color + "24" : "transparent",
        color: bot.color,
        borderColor: bot.color + "60",
      }}
      aria-hidden="true"
      title={bot.name}
    >
      {bot.avatar ? (
        <img src={bot.avatar} alt="" />
      ) : (
        <BotEnergyOrb
          color={bot.color}
          size={Math.max(size - 4, 12)}
          status={status}
          seed={bot.name}
        />
      )}
    </span>
  );
}
