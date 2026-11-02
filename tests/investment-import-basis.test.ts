import { describe, expect, it } from "vitest";
import { MemoryInvestmentStore } from "@/lib/investments/store";
import { valuePortfolio } from "@/lib/investments/value";
const TODAY="2026-11-02";
describe("imported portfolios with unknown historical cost",()=>{
 it("shows reported value without inventing invested money, gain or fallback value from partial flows",async()=>{
  const store=new MemoryInvestmentStore();const imported=await store.create("owner",{name:"Imported fund",kind:"other",investedBefore:"0.00"});store.items[0].importCostBasisUnknown=true;
  await store.addValue("owner",imported.id,"1000.00",TODAY,"reported");await store.addContribution("owner",{investmentId:imported.id,amount:"50.00",currency:"GHS",occurredOn:TODAY,bankMessageId:null,note:"Known later flow"});
  const portfolio=valuePortfolio({investments:await store.list("owner"),holdings:[],values:await store.latestValues("owner"),contributions:await store.contributions("owner"),prices:[],today:TODAY});
  expect(portfolio.items[0]).toMatchObject({value:1000,valueGhs:1000,source:"reported",investedGhs:null,gainGhs:null});expect(portfolio).toMatchObject({totalGhs:1000,investedGhs:null,gainGhs:null});
  const withoutReported=valuePortfolio({investments:await store.list("owner"),holdings:[],values:[],contributions:await store.contributions("owner"),prices:[],today:TODAY});expect(withoutReported.items[0]).toMatchObject({value:null,source:null,investedGhs:null,gainGhs:null});
 });
 it("keeps aggregate basis and gain unknown when a mixed portfolio contains an imported unknown basis",async()=>{
  const store=new MemoryInvestmentStore();const imported=await store.create("owner",{name:"Imported",kind:"other"});store.items[0].importCostBasisUnknown=true;
  const known=await store.create("owner",{name:"Known",kind:"other",investedBefore:"400.00"});await store.addValue("owner",imported.id,"1000.00",TODAY,"reported");await store.addValue("owner",known.id,"500.00",TODAY,"reported");
  const portfolio=valuePortfolio({investments:await store.list("owner"),holdings:[],values:await store.latestValues("owner"),contributions:[],prices:[],today:TODAY});expect(portfolio).toMatchObject({totalGhs:1500,investedGhs:null,gainGhs:null});expect(portfolio.items[1]).toMatchObject({investedGhs:400,gainGhs:100});
 });
});
