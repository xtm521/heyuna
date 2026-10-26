import { useId } from 'react';
/** Three original curved metal ribbons converge at one stem. */
export default function SproutMark({ className = '' }: { className?: string }) {
  const id = useId().replaceAll(':', '');
  return <svg className={className} viewBox="0 0 240 240" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-silver`} x1="38" y1="45" x2="186" y2="212" gradientUnits="userSpaceOnUse"><stop stopColor="#F3F5F6"/><stop offset=".25" stopColor="#8C9F9F"/><stop offset=".48" stopColor="#E4ECE9"/><stop offset=".69" stopColor="#415C57"/><stop offset="1" stopColor="#9FE8D2"/></linearGradient>
      <linearGradient id={`${id}-teal`} x1="186" y1="30" x2="108" y2="211" gradientUnits="userSpaceOnUse"><stop stopColor="#C9FFEE"/><stop offset=".42" stopColor="#4FE0BA"/><stop offset=".75" stopColor="#258571"/><stop offset="1" stopColor="#C7F4E8"/></linearGradient>
    </defs>
    <path d="M119 218C115 178 78 151 48 113C29 89 25 60 32 38C82 51 115 92 115 133C114 163 117 191 119 218Z" fill={`url(#${id}-silver)`}/>
    <path d="M120 219C125 176 169 154 196 109C213 81 214 53 207 26C155 44 126 84 130 126C135 162 124 190 120 219Z" fill={`url(#${id}-teal)`}/>
    <path d="M120 219C133 162 106 126 104 91C102 61 112 39 127 20C153 51 161 76 147 107C131 144 118 173 120 219Z" fill={`url(#${id}-silver)`}/>
    <path d="M119 217C111 155 64 103 34 41M121 216C134 150 181 93 205 30M120 213C120 146 143 93 127 24" stroke="#F3FFF8" strokeOpacity=".27" strokeWidth="1"/>
  </svg>;
}
