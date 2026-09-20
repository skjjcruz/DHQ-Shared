'use strict';
function raw(name='Private A',key='423.l.12345',season='2026'){
 const teams={count:2};
 for(let i=0;i<2;i++)teams[i]={team:[{team_key:key+'.t.'+(i+1),team_id:String(i+1),name:'Fixture team '+(i+1),managers:[{manager:{guid:'fixture-manager-'+i,nickname:'Fixture '+i}}]},{roster:{players:{count:0}}}]};
 return{fantasy_content:{league:[{league_key:key,name,season,num_teams:2},{teams,settings:{roster_positions:{roster_position:[{position:'QB',count:1}]},stat_modifiers:{stats:{stat:[{stat_id:4,value:'0.04'}]}}},transactions:{count:0}}]}};
}
module.exports={raw};
