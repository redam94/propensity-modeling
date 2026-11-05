import pytest

from propensity_lift import make_brand_lift_sample


@pytest.fixture(scope="session")
def sample_df():
    return make_brand_lift_sample(n=3000, seed=0)


@pytest.fixture(scope="session")
def small_df():
    return make_brand_lift_sample(n=1200, seed=1)
