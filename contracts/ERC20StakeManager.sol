// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.12;

/* solhint-disable reason-string */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IOracle.sol";

abstract contract ERC20StakeManager is Ownable {
    using SafeERC20 for IERC20;
    //calculated cost of the postOp
    uint256 public constant COST_OF_POST = 35000;

    IOracle private constant NULL_ORACLE = IOracle(address(0));
    mapping(IERC20 => IOracle) public oracles;
    mapping(IERC20 => mapping(address => uint256)) public balances;
    mapping(address => uint256) public unlockBlock;

    constructor(address _owner) {
        //owner account is unblocked, to allow withdraw of paid tokens;
        _transferOwnership(_owner);
        unlockTokenDeposit();
    }

    /**
     * owner of the paymaster should add supported tokens
     */
    function addToken(
        IERC20 token,
        IOracle tokenPriceOracle
    ) external onlyOwner {
        require(oracles[token] == NULL_ORACLE, "Token already set");
        oracles[token] = tokenPriceOracle;
    }

    /**
     * deposit tokens that a specific account can use to pay for gas.
     * The sender must first approve this paymaster to withdraw these tokens (they are only withdrawn in this method).
     * Note depositing the tokens is equivalent to transferring them to the "account" - only the account can later
     *  use them - either as gas, or using withdrawTo()
     *
     * @param token the token to deposit.
     * @param account the account to deposit for.
     * @param amount the amount of token to deposit.
     */
    function addDepositFor(
        IERC20 token,
        address account,
        uint256 amount
    ) external {
        //(sender must have approval for the paymaster)
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(oracles[token] != NULL_ORACLE, "unsupported token");
        balances[token][account] += amount;
        if (msg.sender == account) {
            lockTokenDeposit();
        }
    }

    /**
     * @return amount - the amount of given token deposited to the Paymaster.
     * @return _unlockBlock - the block height at which the deposit can be withdrawn.
     */
    function getERCDepositInfo(
        IERC20 token,
        address account
    ) public view returns (uint256 amount, uint256 _unlockBlock) {
        amount = balances[token][account];
        _unlockBlock = unlockBlock[account];
    }

    /**
     * unlock deposit, so that it can be withdrawn.
     * can't be called in the same block as withdrawTo()
     */
    function unlockTokenDeposit() public {
        unlockBlock[msg.sender] = block.number;
    }

    /**
     * lock the tokens deposited for this account so they can be used to pay for gas.
     * after calling unlockTokenDeposit(), the account can't use this paymaster until the deposit is locked.
     */
    function lockTokenDeposit() public {
        unlockBlock[msg.sender] = 0;
    }

    /**
     * withdraw tokens.
     * can only be called after unlock() is called in a previous block.
     * @param token the token deposit to withdraw
     * @param target address to send to
     * @param amount amount to withdraw
     */
    function withdrawTokensTo(
        IERC20 token,
        address target,
        uint256 amount
    ) public {
        require(
            unlockBlock[msg.sender] != 0 &&
                block.number > unlockBlock[msg.sender],
            "DepositPaymaster: must unlockTokenDeposit"
        );
        balances[token][msg.sender] -= amount;
        token.safeTransfer(target, amount);
    }

    /**
     * translate the given eth value to token amount
     * @param token the token to use
     * @param ethBought the required eth value we want to "buy"
     * @return requiredTokens the amount of tokens required to get this amount of eth
     */
    function getTokenValueOfEth(
        IERC20 token,
        uint256 ethBought
    ) internal view virtual returns (uint256 requiredTokens) {
        IOracle oracle = oracles[token];
        require(oracle != NULL_ORACLE, "DepositPaymaster: unsupported token");
        return oracle.getTokenValueOfEth(ethBought);
    }

    function decodePaymasterData(
        bytes calldata paymasterAndData
    ) internal pure returns (address erc20Token, uint256 exchangeRate) {
        if (paymasterAndData.length >= 148) {
            (erc20Token, exchangeRate) = abi.decode(
                paymasterAndData[84:],
                (address, uint256)
            );
        }
    }

    function payGasFeeERC20(
        address paymaster,
        address token,
        uint256 exchangeRate,
        uint256 actualGasCost
    ) internal {
        uint256 tokenRequiredFund = (actualGasCost * exchangeRate) / 10 ** 18;
        IERC20(token).safeTransferFrom(
            address(this),
            paymaster,
            tokenRequiredFund
        );
    }
}
