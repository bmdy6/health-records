import { expect, it, vi } from 'vitest';
import { parseFoodLibrary, saveFoodLibrary, loadFoodLibrary } from './food-library';
import { EXT_FOOD_LIBRARY } from './food-data';
import { FOOD_LIBRARY, replaceFoodLibrary } from './nutrition';
it('ships no unlicensed or synthetic production food values',()=>{expect(EXT_FOOD_LIBRARY).toEqual([]);});
it('imports explicit source and numeric values, rejecting duplicates and unsafe values',()=>{
 const good={source:'Fictional test data; not for nutrition',foods:[{name:'Synthetic meal',kcal:100,protein:5,carbs:10,fat:3}]};
 expect(parseFoodLibrary(JSON.stringify(good))).toEqual(good);
 for(const bad of [{...good,source:''},{...good,foods:[...good.foods,...good.foods]},{...good,foods:[{...good.foods[0],kcal:-1}]},{...good,foods:[{...good.foods[0],extra:'x'}]}])expect(()=>parseFoodLibrary(JSON.stringify(bad))).toThrow();
 const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});
 saveFoodLibrary(JSON.stringify(good));replaceFoodLibrary([]);expect(loadFoodLibrary()).toEqual(good);expect(FOOD_LIBRARY).toEqual(good.foods);vi.unstubAllGlobals();
});
