import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describeEvent } from '../src/components/TaskTimeline';
import { mayAnimate, registerEffect, stopVisualEffects } from '../src/components/effects';
import ResizeHandle from '../src/components/ResizeHandle';
const event = (kind:string,message:string) => ({time:'2026-10-26',kind,message});
describe('truthful task steps',()=>{
  it('does not turn tool initiation into completion',()=>{
    expect(describeEvent(event('tool','write_file main.py'))).toEqual({title:'已发起副本修改',detail:'main.py',outcome:'issued'});
    expect(describeEvent(event('tool','future_tool something'))).toMatchObject({outcome:'issued',title:'已发起工具请求'});
  });
  it('uses exit_code/output, not invented stdout or success fields',()=>{
    expect(describeEvent(event('test',JSON.stringify({exit_code:0,output:'2 passed'})))).toMatchObject({title:'测试进程正常结束',detail:'2 passed',outcome:'passed'});
    expect(describeEvent(event('test',JSON.stringify({exit_code:1,output:'assertion failed'})))).toMatchObject({detail:'assertion failed',outcome:'failed'});
    const unknown='{"success":true,"stdout":"not a protocol result"}';
    expect(describeEvent(event('test',unknown))).toEqual({title:'测试输出',detail:unknown,outcome:'plain'});
    expect(describeEvent(event('unknown','<script>alert(1)</script>'))).toMatchObject({detail:'<script>alert(1)</script>',outcome:'plain'});
  });
});
describe('compute takes priority over visual effects',()=>{
  const idle={known:true,contributing:false,taskRunning:false,busy:false,enabled:true,focused:true,visible:true,reducedMotion:false};
  it('animates only positively known idle and visible state',()=>{
    expect(mayAnimate(idle)).toBe(true);
    for(const key of ['known','enabled','focused','visible'] as const) expect(mayAnimate({...idle,[key]:false})).toBe(false);
    for(const key of ['contributing','taskRunning','busy','reducedMotion'] as const) expect(mayAnimate({...idle,[key]:true})).toBe(false);
  });
  it('releases registered GPU resources synchronously before compute proceeds',()=>{
    const order:string[]=[]; const unregister=registerEffect(()=>order.push('dispose'));
    stopVisualEffects(); order.push('submit'); expect(order).toEqual(['dispose','submit']); unregister();
    stopVisualEffects(); expect(order).toHaveLength(2);
  });
});
it('allows keyboard resizing within bounds, including the mirrored assistant pane',()=>{
  function Pane(){const [width,setWidth]=useState(300);return <ResizeHandle label="pane" value={width} setValue={setWidth} min={280} max={520} reverse/>;}
  render(<Pane/>); const handle=screen.getByRole('separator');
  fireEvent.keyDown(handle,{key:'ArrowLeft'});expect(handle).toHaveAttribute('aria-valuenow','316');
  fireEvent.keyDown(handle,{key:'End'});expect(handle).toHaveAttribute('aria-valuenow','520');
  fireEvent.keyDown(handle,{key:'ArrowLeft'});expect(handle).toHaveAttribute('aria-valuenow','520');
  fireEvent.keyDown(handle,{key:'Home'});expect(handle).toHaveAttribute('aria-valuenow','280');
});
