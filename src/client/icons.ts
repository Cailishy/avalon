import { createElement, Volume2, VolumeX, Crown, Check, UserRound, X, Share2, BookOpen, GalleryVerticalEnd, LogOut, Eye, EyeOff, Shield, ShieldX, Flag, ChevronDown, Swords, Copy, RotateCcw, Target, Gamepad2, UserMinus, Info, CircleAlert, Mic, MicOff, Headphones, type IconNode } from "lucide";

const icons: Record<string, IconNode> = { volume: Volume2, muted: VolumeX, crown: Crown, check: Check, user: UserRound, close: X, share: Share2, rules: BookOpen, gallery: GalleryVerticalEnd, leave: LogOut, eye: Eye, hidden: EyeOff, shield: Shield, shieldX: ShieldX, flag: Flag, chevron: ChevronDown, swords: Swords, copy: Copy, restart: RotateCcw, target: Target, solo: Gamepad2, remove: UserMinus, info: Info, alert: CircleAlert, mic: Mic, micOff: MicOff, headphones: Headphones };

export function icon(name: keyof typeof icons, size = 18): string {
  return createElement(icons[name], { width: size, height: size, "aria-hidden": "true", "stroke-width": 1.75 }).outerHTML;
}
