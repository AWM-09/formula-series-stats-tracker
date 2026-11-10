"use strict";
const fs=require("node:fs/promises"),path=require("node:path");
const BASE="https://api.jolpi.ca/ergast/f1",START=1950,END=new Date().getUTCFullYear(),OUT=path.join("data","f1");
const MIN_INTERVAL_MS=900,MAX_RETRIES=8;
let lastRequestAt=0;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function retryDelay(response,attempt){
 const header=response.headers.get("retry-after");
 if(header){const seconds=Number(header);if(Number.isFinite(seconds))return Math.max(1000,seconds*1000);const date=Date.parse(header);if(Number.isFinite(date))return Math.max(1000,date-Date.now());}
 return Math.min(300000,15000*Math.pow(2,attempt));
}
async function request(url){
 for(let attempt=0;attempt<MAX_RETRIES;attempt++){
  const remaining=MIN_INTERVAL_MS-(Date.now()-lastRequestAt);if(remaining>0)await pause(remaining);
  lastRequestAt=Date.now();
  let response;
  try{response=await fetch(url,{headers:{"Accept":"application/json","User-Agent":"FormulaStatsTracker/1.0"}});}
  catch(error){if(attempt===MAX_RETRIES-1)throw error;const delay=Math.min(60000,3000*Math.pow(2,attempt));console.warn("Network issue; retrying in "+Math.round(delay/1000)+"s");await pause(delay);continue;}
  if(response.status===429||response.status>=500){
   if(attempt===MAX_RETRIES-1)throw new Error("HTTP "+response.status+" after retries for "+url);
   const delay=retryDelay(response,attempt);console.warn("Provider returned HTTP "+response.status+"; backing off for "+Math.round(delay/1000)+"s");await pause(delay);continue;
  }
  if(!response.ok)throw new Error("HTTP "+response.status+" for "+url);
  const json=await response.json();if(!json||!json.MRData)throw new Error("Unexpected API response from "+url);return json.MRData;
 }
 throw new Error("Retry limit reached for "+url);
}
async function resultsFor(year){
 let offset=0,total=0;const grouped=new Map();
 do{
  const data=await request(BASE+"/"+year+"/results.json?limit=100&offset="+offset);
  for(const race of (data.RaceTable&&data.RaceTable.Races)||[]){const key=String(race.round);if(!grouped.has(key))grouped.set(key,{...race,Results:[]});grouped.get(key).Results.push(...(race.Results||[]));}
  total=Number(data.total)||0;offset+=Number(data.limit)||100;
 }while(offset<total);
 return Array.from(grouped.values()).sort((a,b)=>Number(a.round)-Number(b.round));
}
async function scheduleFor(year){
 const data=await request(BASE+"/"+year+"/races.json?limit=100");
 return (data.RaceTable&&data.RaceTable.Races)||[];
}
async function sessionResultsFor(year,endpoint,field,sessionName){
 let offset=0,total=0;
 const grouped=new Map();
 do{
  const data=await request(BASE+"/"+year+"/"+endpoint+".json?limit=100&offset="+offset);
  for(const race of (data.RaceTable&&data.RaceTable.Races)||[]){
   const rows=race[field]||[];
   if(!rows.length)continue;
   const converted=rows.map(row=>{
    if(sessionName==="Qualifying"){
     const q1=row.Q1||"",q2=row.Q2||"",q3=row.Q3||"";
     return {...row,session:"Qualifying",Q1:q1,Q2:q2,Q3:q3,Time:{time:q3||q2||q1||""},points:null};
    }
    return {...row,session:sessionName};
   });
   const key=String(race.round);
   if(!grouped.has(key))grouped.set(key,[]);
   grouped.get(key).push(...converted);
  }
  total=Number(data.total)||0;
  offset+=Number(data.limit)||100;
 }while(offset<total);
 return grouped;
}
async function standings(year,type){
 if(type==="constructorStandings"&&year<1958)return [];
 const data=await request(BASE+"/"+year+"/"+type+".json?limit=100");
 const lists=data.StandingsTable&&data.StandingsTable.StandingsLists;
 if(!lists||!lists.length)return [];
 return lists[0][type==="driverStandings"?"DriverStandings":"ConstructorStandings"]||[];
}
async function backfillHistoricalQualifying(year,file,data){
 const qualifying=await sessionResultsFor(year,"qualifying","QualifyingResults","Qualifying");
 const totalRows=Array.from(qualifying.values()).reduce((sum,rows)=>sum+rows.length,0);
 if(!totalRows)throw new Error("Jolpica returned no qualifying classifications for "+year+"; refusing to mark the season complete.");
 const races=Array.isArray(data.races)?data.races:[];
 const byRound=new Map(races.map(race=>[String(race.round),race]));
 let added=0,alreadyPresent=0,unmatched=0;
 for(const [round,rows] of qualifying){
  const event=byRound.get(String(round));
  if(!event){unmatched+=rows.length;continue;}
  if(!Array.isArray(event.Results))event.Results=[];
  if(event.Results.some(result=>String(result.session||"").toLowerCase()==="qualifying")){
   alreadyPresent+=rows.length;
   continue;
  }
  event.Results.push(...rows);
  added+=rows.length;
 }
 if(!added&&!alreadyPresent)throw new Error("Qualifying records could not be matched to existing "+year+" race weekends.");
 if(unmatched)console.warn(year+": "+unmatched+" qualifying rows did not match a stored race round.");
 data.sessionDataVersion=3;
 data.sessionCoverage={
  ...(data.sessionCoverage||{}),
  qualifying:"Jolpica F1 API",
  qualifyingRows:totalRows,
  qualifyingRounds:qualifying.size,
  qualifyingBackfillComplete:true,
  qualifyingBackfilledAt:new Date().toISOString()
 };
 await fs.writeFile(file,JSON.stringify(data));
 console.log(year+": qualifying history backfilled; "+added+" rows added, "+alreadyPresent+" already present across "+qualifying.size+" rounds.");
}

async function main(){
 await fs.mkdir(OUT,{recursive:true});
 for(let year=START;year<=END;year++){
  const file=path.join(OUT,year+".json"),exists=await fs.access(file).then(()=>true).catch(()=>false);
  if(exists&&year===END&&process.env.HISTORICAL_QUALIFYING_BACKFILL_ONLY==="true"){
   console.log("Keeping the existing current-season snapshot during the historical qualifying backfill: "+year);continue;
  }
  if(exists&&year!==END){
   const existingData=JSON.parse(await fs.readFile(file,"utf8"));
   const coverage=existingData.sessionCoverage||{};
   if(existingData.sessionDataVersion>=3&&coverage.qualifyingBackfillComplete===true&&coverage.qualifying==="Jolpica F1 API"){
    console.log("Historical qualifying coverage already complete: "+year);continue;
   }
   console.log("Backfilling historical F1 qualifying classifications for "+year);
   await backfillHistoricalQualifying(year,file,existingData);
   continue;
  }
  console.log("Fetching F1 "+year);
  const races=await resultsFor(year),schedule=await scheduleFor(year),driverStandings=await standings(year,"driverStandings"),constructorStandings=await standings(year,"constructorStandings");
  const qualifying=await sessionResultsFor(year,"qualifying","QualifyingResults","Qualifying");
  const sprints=year>=2021?await sessionResultsFor(year,"sprint","SprintResults","Sprint"):new Map();
  if(year<1958&&constructorStandings.length)throw new Error("Unexpected pre-1958 constructor standings.");
  const resultByRound=new Map(races.map(r=>[String(r.round),r]));
  const mergedRaces=schedule.map(s=>{
   const actual=resultByRound.get(String(s.round));
   const event=actual?{...s,...actual,Circuit:actual.Circuit||s.Circuit}:{...s,Results:[]};
   event.Results=event.Results||[];
   const existing=new Set(event.Results.map(x=>x.session||"Race"));
   for(const [session,rows] of [["Qualifying",qualifying.get(String(s.round))||[]],["Sprint",sprints.get(String(s.round))||[]]]){
    if(rows.length&&!existing.has(session))event.Results.push(...rows);
   }
   return event;
  });
  const calendar=schedule.map(r=>({
   round:String(r.round),raceName:r.raceName,date:r.date||null,time:r.time||null,Circuit:r.Circuit||{},
   FirstPractice:r.FirstPractice||null,SecondPractice:r.SecondPractice||null,ThirdPractice:r.ThirdPractice||null,
   Qualifying:r.Qualifying||null,Sprint:r.Sprint||null,SprintQualifying:r.SprintQualifying||r.SprintShootout||null
  }));
  const data={series:"f1",season:year,sessionDataVersion:3,updatedAt:new Date().toISOString(),source:"Jolpica F1 API",driverStandings,constructorStandings,races:mergedRaces,calendar,sessionCoverage:{qualifying:"Jolpica F1 API",qualifyingRows:Array.from(qualifying.values()).reduce((sum,rows)=>sum+rows.length,0),qualifyingRounds:qualifying.size,qualifyingBackfillComplete:true,qualifyingBackfilledAt:new Date().toISOString(),sprint:year>=2021?"Jolpica F1 API":"Not applicable before 2021",practice:"FastF1 current-season practice imports where available"}};
  if(!races.length&&year<END)throw new Error("No race results returned for historical season "+year+"; refusing to save an empty snapshot.");
  await fs.writeFile(file,JSON.stringify(data));
  console.log(year+": "+races.length+" race weekends, "+driverStandings.length+" driver standings, "+constructorStandings.length+" constructor standings.");
 }
}
main().catch(error=>{console.error(error);process.exit(1);});
