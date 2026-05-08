import React from 'react';

interface HelmIconProps {
  size?: number;
  className?: string;
}

export const HelmIcon: React.FC<HelmIconProps> = ({ size = 256, className = '' }) => {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 512 512" 
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        {/* 深色玻璃态背景渐变 */}
        <linearGradient id="helm-bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1e2130" />
          <stop offset="100%" stopColor="#0d0e15" />
        </linearGradient>

        {/* 边缘高光，增强立体感和质感 */}
        <linearGradient id="helm-edge-highlight" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.2)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.02)" />
        </linearGradient>

        {/* 赛博朋克风青蓝色霓虹渐变 */}
        <linearGradient id="helm-neon-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00f2fe" />
          <stop offset="100%" stopColor="#4facfe" />
        </linearGradient>
        
        {/* 霓虹发光滤镜 */}
        <filter id="helm-neon-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>

        {/* 元素投影 */}
        <filter id="helm-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="12" stdDeviation="16" floodColor="#000000" floodOpacity="0.6"/>
        </filter>
        
        {/* 终端窗口投影 */}
        <filter id="term-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#000000" floodOpacity="0.4"/>
        </filter>
      </defs>

      {/* 1. App Icon Base (macOS 风格圆角矩形) */}
      <rect x="32" y="32" width="448" height="448" rx="100" fill="url(#helm-bg-grad)" filter="url(#helm-shadow)" />
      
      {/* 玻璃态反光边框 */}
      <rect x="33" y="33" width="446" height="446" rx="99" fill="none" stroke="url(#helm-edge-highlight)" strokeWidth="2" />

      {/* 2. 背景中的终端元素 (代表 SSH/代码) */}
      <g filter="url(#term-shadow)">
        <path d="M 106 140 L 406 140 A 24 24 0 0 1 430 164 L 430 338 A 24 24 0 0 1 406 362 L 106 362 A 24 24 0 0 1 82 338 L 82 164 A 24 24 0 0 1 106 140 Z" fill="#000000" fillOpacity="0.3" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        {/* 终端控制按钮 (红黄绿) */}
        <circle cx="114" cy="164" r="6" fill="#ff5f56" />
        <circle cx="134" cy="164" r="6" fill="#ffbd2e" />
        <circle cx="154" cy="164" r="6" fill="#27c93f" />
        {/* 命令行提示符: ~ ❯ */}
        <path d="M 110 200 L 120 210 L 110 220" fill="none" stroke="#27c93f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M 130 220 L 150 220" fill="none" stroke="#4facfe" strokeWidth="3" strokeLinecap="round" />
      </g>

      {/* 3. 核心船舵图案 (代表 Helm/掌控) */}
      <g transform="translate(256, 260)">
        {/* 外部结构 */}
        <circle cx="0" cy="0" r="90" fill="#141622" stroke="url(#helm-bg-grad)" strokeWidth="16" filter="url(#helm-shadow)" />
        <circle cx="0" cy="0" r="90" fill="none" stroke="url(#helm-neon-grad)" strokeWidth="3" filter="url(#helm-neon-glow)" />
        
        {/* 内部圆环 */}
        <circle cx="0" cy="0" r="50" fill="none" stroke="#2a2d3e" strokeWidth="6" />
        <circle cx="0" cy="0" r="50" fill="none" stroke="#4facfe" strokeWidth="1" strokeDasharray="4 4" opacity="0.6"/>
        
        {/* 中心枢纽 */}
        <circle cx="0" cy="0" r="22" fill="#141622" stroke="#2a2d3e" strokeWidth="4" />
        <circle cx="0" cy="0" r="12" fill="url(#helm-neon-grad)" filter="url(#helm-neon-glow)" />

        {/* 船舵的把手/网络节点 */}
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle, i) => (
          <g transform={`rotate(${angle})`} key={i}>
            <rect x="-4" y="-120" width="8" height="30" fill="url(#helm-neon-grad)" rx="4" filter="url(#helm-neon-glow)"/>
            <rect x="-6" y="-90" width="12" height="40" fill="#2a2d3e" rx="3" />
            <circle cx="0" cy="-120" r="5" fill="#ffffff" filter="url(#helm-neon-glow)" />
          </g>
        ))}
      </g>
      
      {/* 4. 底部的网络连接象征 */}
      <path d="M 256 380 L 256 420" stroke="url(#helm-neon-grad)" strokeWidth="4" strokeDasharray="8 4" opacity="0.8" />
      <circle cx="256" cy="430" r="8" fill="#4facfe" filter="url(#helm-neon-glow)" />
      
    </svg>
  );
};
