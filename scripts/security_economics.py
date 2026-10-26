#!/usr/bin/env python3
"""Deterministic scenario arithmetic; synthetic assumptions, not market forecasts."""
import argparse
from decimal import Decimal, getcontext
import json
from pathlib import Path

getcontext().prec=48
D=Decimal
UNIT=10**18
RESERVE=3_960_000*UNIT
WEEKS=1040
SECONDS_PER_WEEK=604800

def schedule(completed_weeks):
    paid=RESERVE*min(max(completed_weeks,0),WEEKS)//WEEKS
    next_payment=RESERVE*(completed_weeks+1)//WEEKS-RESERVE*completed_weeks//WEEKS if 0<=completed_weeks<WEEKS else 0
    return {'completed_weeks':completed_weeks,'paid_aheyuna':str(paid),'reserve_aheyuna':str(RESERVE-paid),'next_week_subsidy_heyuna':str(D(next_payment)/UNIT)}

def model(week,monthly_node_cost,assumed_value,fee_per_tx,tps):
    subsidy=D(schedule(week)['next_week_subsidy_heyuna'])
    weekly_cost=D(monthly_node_cost)*4*12/52
    gross_fees=D(fee_per_tx)*D(tps)*SECONDS_PER_WEEK
    # Illustrative composition: half EVM base fee (2% community tax),
    # half priority fee paid directly to the actual proposer.
    distributable=gross_fees*(D('0.5')*D('0.98')+D('0.5'))
    income=(subsidy+distributable)*D(assumed_value)
    gap=max(weekly_cost-subsidy*D(assumed_value),D(0))
    threshold=None if D(assumed_value)==0 or D(fee_per_tx)==0 else gap/(D(assumed_value)*D(fee_per_tx)*D('.99')*SECONDS_PER_WEEK)
    return {'completed_weeks':week,'monthly_cost_per_node_cny':str(monthly_node_cost),'assumed_cny_per_token':str(assumed_value),'fee_heyuna_per_tx':str(fee_per_tx),'sustained_tps':str(tps),'weekly_cost_cny':str(weekly_cost),'weekly_fee_tokens_after_community_tax':str(distributable),'weekly_subsidy_tokens':str(subsidy),'weekly_net_cny_under_assumptions':str(income-weekly_cost),'break_even_tps_under_assumptions':None if threshold is None else str(threshold)}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path('services/chain/security-economics.json'))
    args=parser.parse_args()
    schedules=[schedule(w) for w in [520,1040,2600]]
    assert schedules[1]['reserve_aheyuna']=='0' and schedules[2]['paid_aheyuna']==str(RESERVE)
    assert sum(RESERVE*(e+1)//WEEKS-RESERVE*e//WEEKS for e in range(WEEKS))==RESERVE
    scenarios=[model(w,c,p,f,t) for w in [520,1040,2600] for c in ['50','250','1000','5000'] for p in ['0','0.01','0.1','1'] for f in ['0.0001','0.001','0.01'] for t in ['0.1','1','10']]
    report={'version':1,'kind':'assumption-sensitivity-not-forecast','research_token_market_value_claimed':False,'baseline_assumed_cny_per_token':'0','validators':4,'initial_bonded_heyuna':'40000','security_reserve_heyuna':'3960000','distribution_community_tax':'0.02','assumed_evm_base_fee_share':'0.5','assumed_evm_priority_fee_share':'0.5','subsidy_epochs':1040,'assumptions':['100% finalized participation and no skipped epochs: maximal scheduled spend. Actual unearned amounts and integer dust stay in reserve.','Constant hypothetical cost, traffic, fee and conversion value; values are not market quotes, offers or redemption commitments.','NoBaseFee=true local bootstrap does not establish sustainable public fee economics.','Costs omit audits, staffing, redundancy, incident response, taxes, hardware replacement and independent operators.','Current application splits final charged EVM priority fees to the actual proposer, while the base-fee remainder enters SDK distribution. This model assumes a 50/50 composition, not an observed public fee market.'],'schedule':schedules,'scenarios':scenarios}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
    lines=['# 安全预算敏感性模拟','', '这是确定性算术模型，不是收入预测。研究币没有已确认兑换价值，基准价值按 0 元计；非零值仅用于展示假设变化。4 个等权验证者的 40,000 枚初始质押不算运营收入。3,960,000 枚补贴从创世预留支出，不增发。','', '| 已运行周数 | 理想累计补贴 HEYUNA | 剩余补贴 HEYUNA | 下一周理想补贴 HEYUNA |','| ---: | ---: | ---: | ---: |']
    for row in schedules:lines.append(f"| {row['completed_weeks']} | {D(row['paid_aheyuna'])/UNIT:f} | {D(row['reserve_aheyuna'])/UNIT:f} | {D(row['next_week_subsidy_heyuna']):.8f} |")
    lines+=['','满参与、每周有最终确认才达到以上理想支出；漏签、整周停机和整数舍入留下的余额不会自动补发。1040 周之后，代码不再从这份预留支付补贴；2600 周不产生额外预算。','', '以下是假设每个节点每月支出 250 元、平均每笔手续费 0.001 HEYUNA 时，需要的持续平均交易量。假设手续费一半为基础费、一半为优先费；基础费扣 2% 社区税，优先费直接给实际提议者，网络合计按 99% 计；运行支出未包括专业运维、审计和冗余。','', '| 假设每枚兑换值（元） | 第 520 周盈亏平衡 TPS | 第 1040/2600 周盈亏平衡 TPS |','| ---: | ---: | ---: |']
    for price in ['0','0.01','0.1','1']:
        values=[model(w,'250',price,'0.001','1')['break_even_tps_under_assumptions'] for w in [520,1040]]
        shown=['无法覆盖现金支出' if v is None else f'{D(v):.6f}' for v in values]
        lines.append(f'| {price} | {shown[0]} | {shown[1]} |')
    lines+=['','完整 JSON 包含 432 个成本、假设兑换值、手续费和交易量组合。所有非零兑换值均是假设，不表示研究币可交易或保证未来价值。','', '当前本地网络关闭动态基础费并允许零费初始化；这不能证明公开网络的抗垃圾交易能力或费用可持续性。应用现已将退款后的最终计费 gas 对应优先费支付给实际提议者，基础费余款保留于 fee_collector 并由 distribution 分配；不销毁基础费。以上 50/50 费用构成仅是情景假设，当前零基础费本地网络不代表公开市场。默认 min_gas_multiplier=0.5 还会将计费 gas 下限设为 gas limit 的一半。','', '独立运营前需要用实际报价与负载替换所有假设，并完成非零基础费、节点恶意行为、参数变更和预算耗尽后的退出机制验证。50 年（2600 周）只是模拟时间点，不是技术领先或持续运营承诺。','']
    args.output.with_suffix('.md').write_text('\n'.join(lines))
    print(json.dumps({'scenarios':len(scenarios),'output':str(args.output),'report':str(args.output.with_suffix('.md'))}))

if __name__=='__main__':main()
