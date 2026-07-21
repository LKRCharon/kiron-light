use std::collections::HashMap;

fn main() {
    let mut scores: HashMap<&str, i32> = HashMap::new();
    scores.insert("blue", 10);
    scores.insert("teal", 20);

    if let Some(value) = scores.get("teal") {
        println!("score:\n{}\tpoints", value);
    }
}
