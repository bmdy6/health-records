import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import TrainingRecords from './TrainingRecords';
import WeightRecorder from './WeightRecorder';
import HealthGoalEditor from './HealthGoalEditor';
it('does not describe an unread training file as no activity', () => {
  const html=renderToStaticMarkup(createElement(TrainingRecords,{records:[],recordsAvailable:false,onSaved:()=>{}}));
  expect(html).toContain('训练记录尚未读全');
  expect(html).not.toContain('这天还没有训练记录');
});
it('blocks new weight entry without the existing-day baseline', () => {
  const html=renderToStaticMarkup(createElement(WeightRecorder,{weights:[],available:false,onSaved:()=>{}}));
  expect(html).toContain('体重尚未读全');
  expect(html).toMatch(/<input[^>]*disabled/);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>保存体重/);
});
it('blocks a new goal save while a reload is in flight', () => {
  const html=renderToStaticMarkup(createElement(HealthGoalEditor,{goal:null,canStart:false,onSaved:()=>{},onClose:()=>{}}));
  expect(html).toMatch(/<fieldset[^>]*disabled/);
  expect(html).toMatch(/<button[^>]*disabled[^>]*>保存目标/);
});
