const EXTENSION_ICON_MAP: Record<string, string> = {
  ".7z": "icon-a-7Z",
  ".apk": "icon-APK",
  ".avi": "icon-AVI",
  ".ai": "icon-AI",
  ".chm": "icon-CHM",
  ".css": "icon-CSS",
  ".csv": "icon-CSV",
  ".docx": "icon-DOCX",
  ".djvu": "icon-DJVU",
  ".gif": "icon-GIF",
  ".htm": "icon-HTML",
  ".html": "icon-HTML",
  ".jar": "icon-JAR",
  ".jpeg": "icon-JPG",
  ".jpg": "icon-JPG",
  ".js": "icon-JS",
  ".json": "icon-JSON",
  ".md": "icon-MD",
  ".mov": "icon-MOV",
  ".mp3": "icon-MP3",
  ".mp4": "icon-MP4",
  ".odp": "icon-ODP",
  ".pdf": "icon-PDF",
  ".png": "icon-PNG",
  ".pptx": "icon-PPTX",
  ".psd": "icon-PSD",
  ".rar": "icon-RAR",
  ".rpm": "icon-RPM",
  ".raw": "icon-RAW",
  ".sql": "icon-SQL",
  ".step": "icon-STEP",
  ".stp": "icon-STEP",
  ".svg": "icon-SVG",
  ".ts": "icon-JS",
  ".txt": "icon-TXT",
  ".vtt": "icon-VTT",
  ".wav": "icon-WAV",
  ".webp": "icon-WEBP",
  ".xml": "icon-XML",
  ".xlsx": "icon-XLSX",
  ".zip": "icon-ZIP"
};

const SHELL_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".cmd",
  ".command",
  ".fish",
  ".ps1",
  ".sh",
  ".zsh"
]);

type FileKindIconProps = {
  path: string;
  isDirectory?: boolean;
  className?: string;
};

export function FileKindIcon({ path, isDirectory = false, className }: FileKindIconProps) {
  if (isDirectory) {
    return <IconfontSymbol symbolId="icon-wenjianjia" className={className} />;
  }

  const iconClass = resolveIconClass(path);
  return <IconfontSymbol symbolId={iconClass ?? "icon-a-huaban1"} className={className} />;
}

function resolveIconClass(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const lowerName = name.toLowerCase();
  const lastDot = lowerName.lastIndexOf(".");
  if (lastDot < 0) {
    return null;
  }
  const ext = lowerName.slice(lastDot);
  if (SHELL_EXTENSIONS.has(ext)) {
    return "icon-SHELL";
  }
  return EXTENSION_ICON_MAP[ext] ?? null;
}

function IconfontSymbol({ symbolId, className }: { symbolId: string; className?: string }) {
  return (
    <svg className={composeClassName(className, "svgfont")} aria-hidden="true">
      <use href={`#${symbolId}`} />
    </svg>
  );
}

function composeClassName(...parts: Array<string | undefined>) {
  return ["file-kind-icon", ...parts.filter(Boolean)].join(" ");
}
