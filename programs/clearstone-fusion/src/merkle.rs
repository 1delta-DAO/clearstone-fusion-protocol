use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::keccak::hashv;

pub const MAX_MERKLE_PROOF_LEN: usize = 20;

const LEAF_DOMAIN: &[u8] = &[0x00];
const NODE_DOMAIN: &[u8] = &[0x01];

pub fn hash_leaf(pubkey: &Pubkey) -> [u8; 32] {
    hashv(&[LEAF_DOMAIN, pubkey.as_ref()]).to_bytes()
}

fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[NODE_DOMAIN, lo, hi]).to_bytes()
}

pub fn verify_resolver(proof: &[[u8; 32]], root: &[u8; 32], leaf_pubkey: &Pubkey) -> bool {
    let mut computed = hash_leaf(leaf_pubkey);
    for sibling in proof {
        computed = hash_pair(&computed, sibling);
    }
    computed == *root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn verifies_single_leaf_tree() {
        let a = pk(1);
        let root = hash_leaf(&a);
        assert!(verify_resolver(&[], &root, &a));
    }

    #[test]
    fn rejects_wrong_leaf_on_single_leaf_tree() {
        let a = pk(1);
        let b = pk(2);
        let root = hash_leaf(&a);
        assert!(!verify_resolver(&[], &root, &b));
    }

    #[test]
    fn verifies_two_leaf_tree_both_directions() {
        let a = pk(1);
        let b = pk(2);
        let la = hash_leaf(&a);
        let lb = hash_leaf(&b);
        let root = hash_pair(&la, &lb);
        assert!(verify_resolver(&[lb], &root, &a));
        assert!(verify_resolver(&[la], &root, &b));
    }

    #[test]
    fn verifies_four_leaf_tree() {
        let a = pk(1);
        let b = pk(2);
        let c = pk(3);
        let d = pk(4);
        let la = hash_leaf(&a);
        let lb = hash_leaf(&b);
        let lc = hash_leaf(&c);
        let ld = hash_leaf(&d);
        let n_ab = hash_pair(&la, &lb);
        let n_cd = hash_pair(&lc, &ld);
        let root = hash_pair(&n_ab, &n_cd);

        assert!(verify_resolver(&[lb, n_cd], &root, &a));
        assert!(verify_resolver(&[la, n_cd], &root, &b));
        assert!(verify_resolver(&[ld, n_ab], &root, &c));
        assert!(verify_resolver(&[lc, n_ab], &root, &d));
    }

    #[test]
    fn rejects_invalid_proof() {
        let a = pk(1);
        let b = pk(2);
        let c = pk(3);
        let la = hash_leaf(&a);
        let lb = hash_leaf(&b);
        let lc = hash_leaf(&c);
        let root = hash_pair(&la, &lb);
        assert!(!verify_resolver(&[lc], &root, &a));
    }

    #[test]
    fn pair_hash_is_order_independent() {
        let a = [0xaau8; 32];
        let b = [0xbbu8; 32];
        assert_eq!(hash_pair(&a, &b), hash_pair(&b, &a));
    }

    #[test]
    fn leaf_and_node_domains_differ() {
        let x = pk(42);
        let leaf = hash_leaf(&x);
        let fake_node = hashv(&[NODE_DOMAIN, x.as_ref()]).to_bytes();
        assert_ne!(leaf, fake_node);
    }
}
