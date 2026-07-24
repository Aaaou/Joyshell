import type React from "react";

export function JoyshellSplash({ closing, centerImage }: { closing: boolean; centerImage: string }) {
  return (
    <div className={`splash-overlay ${closing ? "closing" : ""}`}>
      <div
        className="joyshell-splash"
        style={{ "--duration": "4.2s", "--center-opacity": "0.82" } as React.CSSProperties}
      >
        <svg viewBox="0 0 600 600" role="img" aria-label="Joyshell startup animation">
          <defs>
            <path id="joyshell-splash-word-top" d="M217.3 230.6 A108 108 0 0 1 382.7 230.6" />
            <clipPath id="joyshell-splash-center-clip">
              <circle cx="300" cy="300" r="72" />
            </clipPath>
          </defs>
          <circle cx="300" cy="300" r="238" className="orbit-accent" />
          <circle cx="300" cy="300" r="205" className="orbit-accent" />
          <circle cx="300" cy="300" r="170" className="orbit-accent" />
          <g className="orbit" style={{ "--turn": "405deg" } as React.CSSProperties}>
            <path className="orbit-line" d="M530.9 357.6 A238 238 0 0 1 69.1 357.6" />
            <path className="orbit-line" d="M69.1 242.4 A238 238 0 0 1 530.9 242.4" />
            <circle cx="538" cy="300" r="11" className="dot" />
            <circle cx="62" cy="300" r="11" className="dot" />
          </g>
          <g className="orbit reverse" style={{ "--turn": "-315deg" } as React.CSSProperties}>
            <path className="orbit-line" d="M250.4 498.9 A205 205 0 0 1 102.9 243.5" />
            <path className="orbit-line" d="M152.5 157.6 A205 205 0 0 1 447.5 157.6" />
            <path className="orbit-line" d="M497.1 243.5 A205 205 0 0 1 349.6 498.9" />
            <circle cx="300" cy="505" r="10" className="dot" />
            <circle cx="122.5" cy="197.5" r="10" className="dot" />
            <circle cx="477.5" cy="197.5" r="10" className="dot" />
          </g>
          <g className="orbit" style={{ "--turn": "500deg" } as React.CSSProperties}>
            <path className="orbit-line" d="M352.5 138.3 A170 170 0 1 1 247.5 138.3" />
            <circle cx="300" cy="130" r="12" className="dot" />
          </g>
          <circle cx="300" cy="300" r="132" className="inner-disc" />
          <circle cx="300" cy="300" r="103" className="inner-disc" />
          <image
            className="center-image"
            href={centerImage}
            x="228"
            y="228"
            width="144"
            height="144"
            preserveAspectRatio="xMidYMid slice"
            clipPath="url(#joyshell-splash-center-clip)"
          />
          <g className="word-track word-ssh">
            <text className="word-ring small"><textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">SSHSHELL</textPath></text>
          </g>
          <g className="word-track word-open">
            <text className="word-ring"><textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">OPENSOURCE</textPath></text>
          </g>
          <g className="word-track word-spg">
            <text className="word-ring small"><textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">SPG</textPath></text>
          </g>
          <g className="word-track word-joy">
            <text className="word-ring"><textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">JOYSHELL</textPath></text>
          </g>
        </svg>
      </div>
    </div>
  );
}
