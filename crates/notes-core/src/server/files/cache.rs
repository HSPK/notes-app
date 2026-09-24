use std::collections::VecDeque;

pub(super) fn touch_lru(order: &mut VecDeque<String>, path: &str) {
    if order.back().is_some_and(|candidate| candidate == path) {
        return;
    }
    order.retain(|candidate| candidate != path);
    order.push_back(path.to_owned());
}
