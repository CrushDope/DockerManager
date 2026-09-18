'use client';
import { useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';

export function ComposeEditor({value,onChange,readOnly,errorLines}:{value:string;onChange:(value:string)=>void;readOnly:boolean;errorLines:number[]}) {
  const gutter=useRef<HTMLDivElement>(null);
  const count=value.split('\n').length;
  return <div className={'numbered-editor '+(errorLines.length?'has-errors':'')}>
    <div className="editor-toolbar"><span>docker-compose.yml</span><span>YAML · {readOnly?'只读':'可编辑'} · {count} 行</span></div>
    <div className="editor-surface">
      <div className="line-gutter" aria-hidden="true"><div ref={gutter}>{Array.from({length:count},(_,i)=><div key={i} className={errorLines.includes(i+1)?'error-line':''}>{i+1}</div>)}</div></div>
      <Textarea id="compose" aria-label="Docker Compose YAML 配置" aria-invalid={errorLines.length>0} aria-describedby="compose-validation" spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" className="numbered-code" value={value} readOnly={readOnly} onChange={e=>onChange(e.target.value)} onScroll={e=>{if(gutter.current)gutter.current.style.transform=`translateY(-${e.currentTarget.scrollTop}px)`}}/>
    </div>
  </div>;
}
